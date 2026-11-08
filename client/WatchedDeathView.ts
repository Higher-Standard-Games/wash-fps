import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { FirstPersonPose } from "../../../engine/camera/FirstPersonPose";
import { presentationNow } from "../../../engine/core/PresentationTime";
import { DeathCamera } from "./DeathCamera";

/**
 * Presents a watched player's corpse chase as a spectator pose, live or in a demo.
 */
export class WatchedDeathView {
  private readonly camera = new DeathCamera();
  private entityId: string | null = null;
  private lastMs = 0;
  /** Where they were and which way they faced, last seen alive (or dead, while a sample lasts). */
  private readonly body = new Vector3();
  private bodyKnown = false;
  private heading = 0;
  private readonly position = new Vector3();
  private readonly look = new Vector3();

  /**
   * `eye` while they live; once `dead`, the chase of their body. A dead player
   * often has no sample (`eye` and `body` null): the chase keeps to where they
   * were last seen, and starts behind them at the heading they died facing.
   */
  pose(
    entityId: string,
    eye: FirstPersonPose | null,
    body: { x: number; y: number; z: number } | null,
    dead: boolean,
    scene: Scene | null,
  ): FirstPersonPose | null {
    if (entityId !== this.entityId) {
      this.camera.stop();
      this.entityId = entityId;
      this.bodyKnown = false;
    }
    if (body) {
      this.body.set(body.x, body.y, body.z);
      this.bodyKnown = true;
    }
    if (eye) this.heading = eye.yaw;
    if (!dead) {
      this.camera.stop();
      return eye;
    }
    if (!this.bodyKnown) return eye;

    const now = presentationNow();
    if (!this.camera.isActive) {
      this.camera.start(() => this.body, this.body.clone(), this.heading);
      this.lastMs = now;
    }
    const dt = Math.min(0.1, Math.max(0, (now - this.lastMs) / 1000));
    this.lastMs = now;
    this.camera.update(dt, {
      position: this.position,
      setTarget: (target) => this.look.copyFrom(target),
      getScene: scene ? () => scene : undefined,
    });
    const dx = this.look.x - this.position.x;
    const dy = this.look.y - this.position.y;
    const dz = this.look.z - this.position.z;
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      // A camera's heading and pitch for that look: pitch is positive looking down
      yaw: Math.atan2(dx, dz),
      pitch: Math.atan2(-dy, Math.hypot(dx, dz)),
      effects: null,
    };
  }

  stop(): void {
    this.camera.stop();
    this.entityId = null;
    this.bodyKnown = false;
  }
}
