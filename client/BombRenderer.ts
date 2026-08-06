/**
 * BombRenderer — the Search & Destroy bomb, in the world.
 *
 * One mesh, three lives: slung on the carrier's back, lying on the ground, or
 * planted at a site with a light that blinks faster the closer it gets to going
 * off. Everything it draws comes from the server's objective snapshot, so it
 * cannot show a bomb the server does not believe in.
 *
 * Procedural rather than the shipped `models/objects/misc/bomb.md3`, for the
 * same reason the pickups are: one asset pipeline, no runtime MD3 conversion,
 * and a shape that reads at a glance in a firefight. Warsow's own bomb is a
 * bundle of dynamite, which is what this is.
 */

import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { DEFAULT_BOMB_RULES } from "../../../shared/server/gametype/BombModel";
import type { BombObjectiveSnapshot } from "./MatchStateManager";
import { MatchStateManager } from "./MatchStateManager";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";

/** Dynamite stick radius/height, in world units. */
const STICK_RADIUS = 2.6;
const STICK_HEIGHT = 13;
/** Sticks in the bundle, arranged in a ring. */
const STICK_COUNT = 5;
const BUNDLE_RADIUS = 3.4;

/** Where on the carrier's back it rides, relative to the spine bone, in WORLD units. */
const BACK_OFFSET = new Vector3(0, -6, 10);
const CARRY_SCALE = 0.75;
/** Shoulder height above the carrier's origin, when there is no bone to use. */
const CARRY_FALLBACK_HEIGHT = 28;

/** Lift off the floor when dropped, so it does not z-fight with the ground. */
const GROUND_LIFT = 6;

/** Idle bob and spin while loose on the ground, so it reads as a pickup. */
const LOOSE_SPIN_RATE = 1.4;
const LOOSE_BOB_AMPLITUDE = 2.5;
const LOOSE_BOB_RATE = 2.2;

/**
 * The zone ring, drawn on the floor wherever the bomb is sitting.
 *
 * Radius comes from the rule itself rather than a number picked to look right:
 * this is the distance inside which the bomb can be reached, and a ring that
 * disagreed with it would teach players the wrong thing. A dropped bomb is
 * small and easy to lose against a detailed floor, and the arm/defuse radius is
 * otherwise invisible — both problems are the same missing circle.
 */
const ZONE_RADIUS = DEFAULT_BOMB_RULES.armDefuseRadius;
const ZONE_THICKNESS = 3.2;
const ZONE_LIFT = 2;
const ZONE_TESSELLATION = 64;
/** Pulses per second while armed, so the ring reads as urgent, not decorative. */
const ZONE_PULSE_HZ = 1.6;

export class BombRenderer {
  private readonly scene: Scene;
  private readonly root: TransformNode;
  private readonly light: Mesh;
  private readonly lightMaterial: StandardMaterial;
  private readonly zone: Mesh;
  private readonly zoneMaterial: StandardMaterial;
  /** Seconds accumulated for the loose-bomb bob, kept off wall-clock. */
  private elapsed = 0;

  /**
   * Resolved per frame, never captured.
   *
   * The remote renderer is built on the first snapshot; this renderer is built
   * on the first frame that has a scene, which is earlier. Taking the renderer
   * as a value here captured `null` for the lifetime of the session, so the
   * carried bomb — the state it spends most of a round in — could never find a
   * spine to ride and hid itself instead.
   */
  constructor(
    scene: Scene,
    private readonly getPlayers: () => RemotePlayerRenderer | null,
  ) {
    this.scene = scene;
    this.root = new TransformNode("bomb_root", scene);
    this.root.setEnabled(false);

    const body = new StandardMaterial("bomb_body_mat", scene);
    body.diffuseColor = new Color3(0.42, 0.13, 0.09);
    body.specularColor = new Color3(0.1, 0.1, 0.1);

    const band = new StandardMaterial("bomb_band_mat", scene);
    band.diffuseColor = new Color3(0.15, 0.13, 0.11);
    band.specularColor = Color3.Black();

    for (let i = 0; i < STICK_COUNT; i++) {
      const angle = (i / STICK_COUNT) * Math.PI * 2;
      const stick = CreateCylinder(
        `bomb_stick_${i}`,
        { diameter: STICK_RADIUS * 2, height: STICK_HEIGHT, tessellation: 10 },
        scene,
      );
      stick.material = body;
      stick.parent = this.root;
      stick.position.set(Math.cos(angle) * BUNDLE_RADIUS, 0, Math.sin(angle) * BUNDLE_RADIUS);
    }

    const strap = CreateCylinder(
      "bomb_strap",
      { diameter: (BUNDLE_RADIUS + STICK_RADIUS) * 2.15, height: 3, tessellation: 14 },
      scene,
    );
    strap.material = band;
    strap.parent = this.root;

    // The timer light. Emissive so it stays legible in a dark corner, which is
    // where a planted bomb usually is.
    this.lightMaterial = new StandardMaterial("bomb_light_mat", scene);
    this.lightMaterial.diffuseColor = new Color3(0.5, 0.05, 0.05);
    this.lightMaterial.emissiveColor = Color3.Black();
    this.lightMaterial.specularColor = Color3.Black();

    this.light = CreateBox("bomb_light", { size: 3.2 }, scene);
    this.light.material = this.lightMaterial;
    this.light.parent = this.root;
    this.light.position.set(0, STICK_HEIGHT * 0.5, 0);

    // The zone ring. Its own node, NOT parented to the bomb: the bomb bobs,
    // spins and rides a carrier's spine, and a ring doing any of that would
    // stop reading as a fixed circle on the floor.
    this.zoneMaterial = new StandardMaterial("bomb_zone_mat", scene);
    this.zoneMaterial.diffuseColor = Color3.Black();
    this.zoneMaterial.specularColor = Color3.Black();
    this.zoneMaterial.alpha = 0.55;
    this.zoneMaterial.disableLighting = true;

    this.zone = CreateTorus(
      "bomb_zone",
      { diameter: ZONE_RADIUS * 2, thickness: ZONE_THICKNESS, tessellation: ZONE_TESSELLATION },
      scene,
    );
    this.zone.material = this.zoneMaterial;
    this.zone.isPickable = false;
    // Never blocks a shot or a trace, and never eats a click.
    this.zone.checkCollisions = false;
    this.zone.setEnabled(false);
  }

  /**
   * Called every frame. `dt` is seconds.
   *
   * Reads the objective snapshot directly rather than being pushed events: the
   * bomb has exactly one authoritative state and no history worth replaying, so
   * polling it cannot drift out of sync the way an event stream can.
   */
  update(dt: number): void {
    const bomb = MatchStateManager.getInstance().bomb;
    if (!bomb || bomb.phase === "defused" || bomb.phase === "detonated") {
      this.hide();
      return;
    }

    this.elapsed += dt;
    this.root.setEnabled(true);

    if (bomb.phase === "carried" && bomb.carrier) {
      this.carry(bomb.carrier);
    } else {
      this.place(bomb);
    }

    this.updateZone(bomb);
    this.updateLight(bomb);
  }

  /**
   * The circle on the floor, wherever the bomb is sitting.
   *
   * Hidden while carried — the zone means nothing on a moving back, and a ring
   * sliding around the map with a runner would be noise. Colour carries the
   * state, because the two cases the ring answers are different questions:
   * gold for a loose bomb ("it is here, come and get it"), red and pulsing once
   * armed ("this is the ground you have to be standing on").
   */
  private updateZone(bomb: BombObjectiveSnapshot): void {
    if (bomb.phase === "carried") {
      this.zone.setEnabled(false);
      return;
    }

    this.zone.setEnabled(true);
    this.zone.position.set(bomb.x, bomb.y + ZONE_LIFT, bomb.z);

    const armed = bomb.phase === "armed";
    if (armed) {
      // Same pulse the timer light runs on, so the two read as one signal
      // rather than two things blinking at each other.
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * ZONE_PULSE_HZ * Math.PI * 2);
      this.zoneMaterial.emissiveColor.set(0.85, 0.12 + pulse * 0.1, 0.1);
      this.zoneMaterial.alpha = 0.45 + pulse * 0.35;
    } else if (bomb.phase === "planted") {
      this.zoneMaterial.emissiveColor.set(0.95, 0.45, 0.08);
      this.zoneMaterial.alpha = 0.6;
    } else {
      this.zoneMaterial.emissiveColor.set(0.98, 0.78, 0.15);
      this.zoneMaterial.alpha = 0.5;
    }
  }

  /**
   * Ride on the carrier's back, tracking their spine in WORLD space.
   *
   * Not parented to the bone. Bone space carries the rig's 36x import scale, so
   * a mesh attached there renders about thirty times its size — big enough that
   * the bomb enclosed everyone standing near the carrier, which looked like
   * every player was carrying one. Following a point and a facing has no scale
   * to get wrong.
   */
  private carry(carrier: string): void {
    const players = this.getPlayers();
    const anchor = players?.getBoneAnchor(carrier, "Spine1") ?? this.carrierFallback(players, carrier);
    if (!anchor) {
      // Nobody to hang it on: the carrier is outside PVS, so they are not on
      // screen either and there is nothing for the bomb to be attached to.
      this.root.setEnabled(false);
      return;
    }
    // Behind them, by their own facing, so it reads as worn rather than stuck
    // to a compass direction.
    const back = BACK_OFFSET.z;
    this.root.position.set(
      anchor.position.x - Math.sin(anchor.yaw) * back,
      anchor.position.y + BACK_OFFSET.y,
      anchor.position.z - Math.cos(anchor.yaw) * back,
    );
    this.root.rotation.set(Math.PI / 2, anchor.yaw, 0);
    this.root.scaling.setAll(CARRY_SCALE);
  }

  /**
   * Where to hang the bomb when the spine bone cannot be resolved.
   *
   * A bone needs a loaded, skinned model, and that arrives some time after the
   * player does — every carrier therefore has a window where the bone lookup
   * misses. Hiding the bomb through that window is the worst answer available:
   * who is carrying it is the single most important thing on the screen for
   * both teams, and an intermittently invisible bomb is indistinguishable from
   * no bomb at all.
   *
   * The hitbox is enough. It is where the player is drawn, and shoulder height
   * off their origin is close enough to a back that nobody reads it as wrong.
   */
  private carrierFallback(
    players: RemotePlayerRenderer | null | undefined,
    carrier: string,
  ): { position: Vector3; yaw: number } | null {
    const drawn = players?.getRenderedPlayers().get(carrier);
    if (!drawn || drawn.dead) return null;
    return {
      position: new Vector3(drawn.position.x, drawn.position.y + CARRY_FALLBACK_HEIGHT, drawn.position.z),
      yaw: players?.getSmoothedYaw(carrier) ?? 0,
    };
  }

  /** Sit in the world at the position the server reports. */
  private place(bomb: BombObjectiveSnapshot): void {
    const planted = bomb.phase === "planted" || bomb.phase === "armed";
    const bob = planted ? 0 : Math.sin(this.elapsed * LOOSE_BOB_RATE) * LOOSE_BOB_AMPLITUDE;

    this.root.position.set(bomb.x, bomb.y + GROUND_LIFT + bob, bomb.z);
    // A planted bomb sits still and upright; a loose one turns, because it is
    // something to go and pick up and should read like every other pickup.
    this.root.rotation.set(0, planted ? 0 : this.elapsed * LOOSE_SPIN_RATE, 0);
    this.root.scaling.setAll(1);
  }

  /**
   * Blink the timer light in step with the server's beep interval.
   *
   * Deliberately driven by the SAME number the audio uses, so the light and the
   * sound are one signal rather than two that drift apart. The interval shortens
   * as the fuse runs down, which is what makes a bomb feel like it is about to
   * go off without any staged thresholds.
   */
  private updateLight(bomb: BombObjectiveSnapshot): void {
    if (bomb.phase !== "armed" || bomb.beepInterval === null || bomb.beepInterval <= 0) {
      // Planted but not armed: a dim steady red, so it is findable but does not
      // pretend the round has inverted yet.
      this.lightMaterial.emissiveColor = bomb.phase === "planted" ? new Color3(0.25, 0.02, 0.02) : Color3.Black();
      return;
    }

    // A short flash at the top of each interval rather than a sine: a blink is
    // read as an event, a pulse is read as an ambience.
    const phase = (this.elapsed % bomb.beepInterval) / bomb.beepInterval;
    const lit = phase < 0.25;
    this.lightMaterial.emissiveColor = lit ? new Color3(1, 0.15, 0.1) : new Color3(0.2, 0.02, 0.02);
  }

  private hide(): void {
    this.root.setEnabled(false);
    // The ring is not parented to the root, so it needs hiding on its own —
    // otherwise a defused bomb leaves its circle painted on the floor.
    this.zone.setEnabled(false);
  }

  dispose(): void {
    this.root.dispose(false, true);
    this.lightMaterial.dispose();
    this.zone.dispose(false, true);
    this.zoneMaterial.dispose();
    void this.scene;
  }
}
