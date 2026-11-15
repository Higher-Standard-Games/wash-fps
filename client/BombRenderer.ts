/**
 * BombRenderer — the Search & Destroy bomb, in the world.
 *
 * One model, three lives: slung on the carrier's back like a pack, lying on
 * the ground, or planted at a site, flashing in step with the fuse. Everything
 * it draws comes from the server's objective snapshot, so it cannot show a
 * bomb the server does not believe in.
 *
 * The model is the EMP charge from the model pack (`models/bomb_emp.glb`): its
 * purple parts glow, and the lightning disc on each pole ripples. The glow is
 * strongest on a carrier's back, where a purple light also follows it, because
 * who has the bomb is the first thing both teams look for.
 */

import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { background } from "../../../engine/core/AsyncErrors";
import { addToDynamicLightCluster, disposeClusteredLight } from "../../../engine/lighting/DynamicLightCluster";
import { renderToggle } from "../../../engine/rendering/RenderToggles";
import { DEFAULT_BOMB_RULES } from "../../../shared/server/gametype/BombModel";
import { BombFloorDecal } from "./bomb/BombFloorDecal";
import { EmpBombModel } from "./bomb/EmpBombModel";
import type { BombObjectiveSnapshot } from "./MatchStateManager";
import { MatchStateManager } from "./MatchStateManager";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";

/** The model spans about 0.92 units; at this scale the bomb is 16 world units across. */
const MODEL_SCALE = 17.4;
/** The bomb's radius at full size, in world units. */
const BOMB_RADIUS = 8;

/** Where on the carrier's back it rides, relative to the spine bone, in WORLD units. */
const BACK_OFFSET = new Vector3(0, 4, 12);
const CARRY_SCALE = 0.75;
/** Shoulder height above the carrier's origin, when there is no bone to use. */
const CARRY_FALLBACK_HEIGHT = 28;

/** Idle bob and spin while loose on the ground, so it reads as a pickup. */
const LOOSE_SPIN_RATE = 1.4;
const LOOSE_BOB_AMPLITUDE = 2.5;
const LOOSE_BOB_RATE = 2.2;

/**
 * Glow, as multiples of the lit surface: `shell` for the purple parts all
 * over the bomb, `core` for the lightning disc. Above 1, bloom picks them up.
 */
const GLOW = {
  loose: { shell: 1.6, core: 1.6 },
  carried: { shell: 3, core: 2.6 },
  planted: { shell: 1.2, core: 1.2 },
  armed: { shell: 1.4, core: 1.4 },
  /** The flash at the top of each fuse beep. */
  beep: { shell: 4.5, core: 4.5 },
} as const;

/** The purple light that follows a carried bomb. */
const CARRY_LIGHT_COLOR = new Color3(0.62, 0.18, 1);
const CARRY_LIGHT_RANGE = 110;
const CARRY_LIGHT_INTENSITY = 3;

/**
 * The glow on the floor under a bomb that is not carried.
 *
 * Radius comes from the rule itself rather than a number picked to look right:
 * this is the distance inside which the bomb can be armed or defused, and a
 * glow that disagreed with it would teach players the wrong thing. It also
 * makes a dropped bomb easy to find against a detailed floor.
 *
 * Colour carries the state: purple, the bomb's own colour, while it lies loose
 * ("it is here, come and get it"); amber once planted; red and pulsing once
 * armed ("this is the ground you have to be standing on"). Armed, it turns
 * faster as the fuse runs down.
 */
const FLOOR_RADIUS = DEFAULT_BOMB_RULES.armDefuseRadius;
const FLOOR_COLOR = {
  loose: new Color3(0.62, 0.2, 1),
  planted: new Color3(1, 0.5, 0.1),
  armed: new Color3(1, 0.12, 0.08),
} as const;
const FLOOR_STRENGTH = { loose: 1, planted: 1, armed: 0.75 } as const;
/** Radians a second; armed adds up to FLOOR_ARMED_SPIN_MAX more as the beeps quicken. */
const FLOOR_SPIN = 0.5;
const FLOOR_ARMED_SPIN_MAX = 2.5;
/** Pulses per second while armed, so the glow reads as urgent, not decorative. */
const FLOOR_PULSE_HZ = 1.6;

export class BombRenderer {
  private readonly scene: Scene;
  private readonly root: TransformNode;
  private readonly floor: BombFloorDecal;
  /** The model, once loaded. Until then (and if it never loads) only the floor glow draws. */
  private model: EmpBombModel | null = null;
  /** The purple light on a carrier, while there is one. */
  private carryLight: PointLight | null = null;
  private disposed = false;
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
    background(this.loadModel(), "BombRenderer");

    // Its own node, NOT parented to the bomb: the bomb bobs and rides a
    // carrier's spine, and a floor glow doing either would stop reading as the
    // ground around it.
    this.floor = new BombFloorDecal(scene, FLOOR_RADIUS);
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

    this.updateFloor(bomb, dt);
    this.updateGlow(bomb);
    this.updateCarryLight(bomb.phase === "carried" && this.root.isEnabled());
  }

  private async loadModel(): Promise<void> {
    const model = await EmpBombModel.load(this.scene, MODEL_SCALE);
    if (!model) return;
    if (this.disposed) {
      model.dispose();
      return;
    }
    model.root.parent = this.root;
    this.model = model;
  }

  /**
   * The glow on the floor, wherever the bomb is sitting. Hidden while carried:
   * the radius means nothing on a moving back.
   */
  private updateFloor(bomb: BombObjectiveSnapshot, dt: number): void {
    if (bomb.phase === "carried") {
      this.floor.hide();
      return;
    }
    if (bomb.phase === "armed") {
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * FLOOR_PULSE_HZ * Math.PI * 2);
      // 5 s between beeps at the start of the fuse, 0.2 s at the end
      const urgency = bomb.beepInterval && bomb.beepInterval > 0 ? Math.min(1, 0.2 / bomb.beepInterval) : 0;
      const spin = FLOOR_SPIN + FLOOR_ARMED_SPIN_MAX * urgency;
      this.floor.show(bomb.x, bomb.y, bomb.z, FLOOR_COLOR.armed, FLOOR_STRENGTH.armed * (0.6 + 0.6 * pulse), spin, dt);
    } else if (bomb.phase === "planted") {
      this.floor.show(bomb.x, bomb.y, bomb.z, FLOOR_COLOR.planted, FLOOR_STRENGTH.planted, FLOOR_SPIN, dt);
    } else {
      this.floor.show(bomb.x, bomb.y, bomb.z, FLOOR_COLOR.loose, FLOOR_STRENGTH.loose, FLOOR_SPIN, dt);
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
    // to a compass direction. Turned with them, so one lightning disc faces
    // whoever is chasing.
    const back = BACK_OFFSET.z;
    this.root.position.set(
      anchor.position.x - Math.sin(anchor.yaw) * back,
      anchor.position.y + BACK_OFFSET.y,
      anchor.position.z - Math.cos(anchor.yaw) * back,
    );
    this.root.rotation.set(0, anchor.yaw, 0);
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
    // The bob stays above the floor: the bomb rests on it at the bottom of each swing.
    const bob = planted ? 0 : (1 + Math.sin(this.elapsed * LOOSE_BOB_RATE)) * LOOSE_BOB_AMPLITUDE;

    this.root.position.set(bomb.x, bomb.y + BOMB_RADIUS + bob, bomb.z);
    // A planted bomb sits still and upright; a loose one turns, because it is
    // something to go and pick up and should read like every other pickup.
    this.root.rotation.set(0, planted ? 0 : this.elapsed * LOOSE_SPIN_RATE, 0);
    this.root.scaling.setAll(1);
  }

  /**
   * How brightly the bomb glows in its current state.
   *
   * Armed, it flashes in step with the server's beep interval: deliberately
   * the SAME number the audio uses, so the flash and the sound are one signal
   * rather than two that drift apart. The interval shortens as the fuse runs
   * down, which is what makes a bomb feel like it is about to go off without
   * any staged thresholds.
   */
  private updateGlow(bomb: BombObjectiveSnapshot): void {
    if (!this.model) return;
    let glow: { shell: number; core: number } = GLOW.loose;
    if (bomb.phase === "carried") glow = GLOW.carried;
    else if (bomb.phase === "planted") glow = GLOW.planted;
    else if (bomb.phase === "armed") {
      glow = GLOW.armed;
      if (bomb.beepInterval !== null && bomb.beepInterval > 0) {
        // A short flash at the top of each interval rather than a sine: a
        // blink is read as an event, a pulse is read as an ambience.
        const phase = (this.elapsed % bomb.beepInterval) / bomb.beepInterval;
        if (phase < 0.25) glow = GLOW.beep;
      }
    }
    this.model.setGlow(glow.shell, glow.core, this.elapsed);
  }

  /**
   * A purple light that travels with a carried bomb, so the carrier glows
   * purple too. Clustered, so it costs one material light however many
   * others are about; off with `r_dynamiclight 0`.
   */
  private updateCarryLight(carried: boolean): void {
    if (!carried || !renderToggle("r_dynamiclight")) {
      this.removeCarryLight();
      return;
    }
    if (!this.carryLight) {
      const light = new PointLight("bomb_carry_light", this.root.position.clone(), this.scene);
      light.diffuse = CARRY_LIGHT_COLOR.clone();
      light.specular = CARRY_LIGHT_COLOR.clone();
      light.range = CARRY_LIGHT_RANGE;
      light.intensity = CARRY_LIGHT_INTENSITY;
      addToDynamicLightCluster(this.scene, light);
      this.carryLight = light;
    }
    this.carryLight.position.copyFrom(this.root.position);
  }

  private removeCarryLight(): void {
    if (!this.carryLight) return;
    disposeClusteredLight(this.carryLight);
    this.carryLight = null;
  }

  private hide(): void {
    this.root.setEnabled(false);
    // The floor glow is not parented to the root, so it needs hiding on its
    // own — otherwise a defused bomb leaves its glow on the floor.
    this.floor.hide();
    this.removeCarryLight();
  }

  dispose(): void {
    this.disposed = true;
    this.removeCarryLight();
    this.model?.dispose();
    this.model = null;
    this.root.dispose(false, true);
    this.floor.dispose();
  }
}
