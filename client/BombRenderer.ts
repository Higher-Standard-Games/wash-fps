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
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { BombObjectiveSnapshot } from "./MatchStateManager";
import { MatchStateManager } from "./MatchStateManager";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";

/** Dynamite stick radius/height, in world units. */
const STICK_RADIUS = 2.6;
const STICK_HEIGHT = 13;
/** Sticks in the bundle, arranged in a ring. */
const STICK_COUNT = 5;
const BUNDLE_RADIUS = 3.4;

/** Where on the carrier's back it rides, relative to the spine bone. */
const BACK_OFFSET = new Vector3(0, -6, -7);
const CARRY_SCALE = 0.75;

/** Lift off the floor when dropped, so it does not z-fight with the ground. */
const GROUND_LIFT = 6;

/** Idle bob and spin while loose on the ground, so it reads as a pickup. */
const LOOSE_SPIN_RATE = 1.4;
const LOOSE_BOB_AMPLITUDE = 2.5;
const LOOSE_BOB_RATE = 2.2;

export class BombRenderer {
  private readonly scene: Scene;
  private readonly root: TransformNode;
  private readonly light: Mesh;
  private readonly lightMaterial: StandardMaterial;
  /** Entity key of the carrier the bomb is currently attached to. */
  private attachedTo: string | null = null;
  /** Seconds accumulated for the loose-bomb bob, kept off wall-clock. */
  private elapsed = 0;

  constructor(
    scene: Scene,
    private readonly players: RemotePlayerRenderer | null,
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

    this.updateLight(bomb);
  }

  /** Ride on the carrier's back, following the spine so it moves with them. */
  private carry(carrier: string): void {
    if (this.attachedTo !== carrier) {
      this.detach();
      const spine = this.players?.getBoneTransform(carrier, "Spine1");
      if (!spine) {
        // No model yet (just joined, or out of PVS). Stay hidden rather than
        // stranding the bomb at the origin — it will attach next frame.
        this.root.setEnabled(false);
        return;
      }
      this.root.parent = spine;
      this.attachedTo = carrier;
    }

    this.root.position.copyFrom(BACK_OFFSET);
    this.root.rotation.set(Math.PI / 2, 0, 0);
    this.root.scaling.setAll(CARRY_SCALE);
  }

  /** Sit in the world at the position the server reports. */
  private place(bomb: BombObjectiveSnapshot): void {
    this.detach();

    const planted = bomb.phase === "planted" || bomb.phase === "armed";
    const bob = planted ? 0 : Math.sin(this.elapsed * LOOSE_BOB_RATE) * LOOSE_BOB_AMPLITUDE;

    this.root.position.set(bomb.x, bomb.y + GROUND_LIFT + bob, bomb.z);
    // A planted bomb sits still and upright; a loose one turns, because it is
    // something to go and pick up and should read like every other pickup.
    this.root.rotation.set(0, planted ? 0 : this.elapsed * LOOSE_SPIN_RATE, 0);
    this.root.scaling.setAll(1);
  }

  private detach(): void {
    if (this.attachedTo === null) return;
    this.root.parent = null;
    this.attachedTo = null;
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
    this.detach();
    this.root.setEnabled(false);
  }

  dispose(): void {
    this.detach();
    this.root.dispose(false, true);
    this.lightMaterial.dispose();
    void this.scene;
  }
}
