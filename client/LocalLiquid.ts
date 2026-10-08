/**
 * LocalLiquid — the client's water presentation for one map: the underwater
 * view, splashes and ripples where bodies cross a surface, the local player's
 * air, and the jump-pad launch sound.
 *
 * Moved out of Game unchanged. Game keeps its public names (localDrowning,
 * cameraSubmersion, debugSplash, ...) as pass-throughs, so callers did not move.
 */

import { EngineStore } from "@babylonjs/core/Engines/engineStore";
import type { Scene } from "@babylonjs/core/scene";
import type { CollisionWorld } from "../../../engine/network/systems/collision/CollisionWorld";
import RenderVars from "../../../engine/rendering/RenderVars";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { LiquidInteractionSystem } from "../liquid/client/LiquidInteractionSystem";
import { LocalAirTracker } from "../liquid/client/LocalAirTracker";
import { UnderwaterView } from "../liquid/client/UnderwaterView";
import { playDrownGasp, playDrownTick } from "./FPSLiquidAudio";
import { playJumppadLaunch } from "./FPSMovementAudio";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";
import type { V2NetworkClient } from "./V2NetworkClient";

export class LocalLiquid {
  /** Tint, fog and view warp while the camera itself is under a surface. */
  private underwaterView: UnderwaterView | null = null;

  /** Splashes and ripples where bodies cross a surface. Owned per map. */
  private liquidInteractions: LiquidInteractionSystem | null = null;

  /** Local air, mirrored for the HUD and the gasp. Presentation only. */
  private airTracker: LocalAirTracker | null = null;

  /** Edge-detect state for the jumppad one-shot; see emitLocalCrossing. */
  private _wasJumppadLaunching = false;

  /** The splash and ripple system, for callers that report their own crossings. */
  get interactions(): LiquidInteractionSystem | null {
    return this.liquidInteractions;
  }

  /**
   * Underwater presentation asks the collision world what the CAMERA is
   * standing in, which is not always what the player is standing in. The
   * interaction system asks the same world where the waterline is, and how
   * far a ring may spread before it runs out of pool.
   */
  setCollisionWorld(collision: CollisionWorld | null): void {
    this.underwaterView?.setCollisionWorld(collision);
    this.liquidInteractions?.setCollisionWorld(collision);
  }

  /**
   * Begin driving underwater presentation for this scene.
   *
   * Separate from construction because the scene is rebuilt on every map load
   * and the previous view must be disposed with it — otherwise the next map
   * inherits a fog state it never asked for.
   */
  start(scene: Scene, remoteRenderer: RemotePlayerRenderer | null): void {
    this.underwaterView?.dispose();
    this.underwaterView = new UnderwaterView(scene);
    this.underwaterView.onSubmersion = (amount) => {
      getWeaponViewManager().submersionAmount = amount;
    };
    this.underwaterView.start();

    this.liquidInteractions?.dispose();
    this.liquidInteractions = new LiquidInteractionSystem(scene);
    // The remote renderer already sees every player's water level each frame,
    // so it is the cheapest place to notice a crossing.
    if (remoteRenderer) remoteRenderer.liquidInteractions = this.liquidInteractions;

    // Splash crowns from Medium up.
    //
    // They were Epic-only on the assumption that spray was expensive, which
    // was true of the FluidRenderer implementation and is not true of what
    // replaced it: one mesh, one draw call, no render target and no
    // post-process. The thing that actually costs at Epic is the pair of
    // scene passes for refraction and reflection, and the crown has nothing
    // to do with either. Only Low goes without.
    if ((RenderVars.getInstance().get("r_water_quality") ?? 2) >= 2) {
      if (!this.liquidInteractions.enableCrowns()) {
        console.info("[Water] Epic splashes unavailable; using ripples");
      }
    }

    this.airTracker = new LocalAirTracker();
    this.airTracker.onStartedDrowning = playDrownGasp;
    this.airTracker.onDrownTick = playDrownTick;
  }

  /** Drop a despawned projectile from liquid-crossing tracking. */
  forgetProjectile(entityId: string): void {
    this.liquidInteractions?.forgetProjectile(entityId);
  }

  /** Re-baseline the local body after a respawn or teleport. */
  forgetLocal(): void {
    this.liquidInteractions?.forget("local");
  }

  /** Refill the local air mirror on respawn. */
  resetAir(): void {
    this.airTracker?.reset();
  }

  /** Local air remaining, 0-1. For the HUD; not authoritative. */
  get airFraction(): number {
    return this.airTracker?.air ?? 1;
  }

  /** True once the lungs are empty. Drives the HUD's alarm state. */
  get drowning(): boolean {
    return this.airTracker?.drowning ?? false;
  }

  /** Fire a splash on demand, through the same path a real crossing takes. */
  debugSplash(position: { x: number; y: number; z: number }): void {
    const id = `debug-splash-${performance.now()}`;
    this.liquidInteractions?.notify(id, 0, "water", position, -400, true);
    this.liquidInteractions?.notify(id, 2, "water", position, -400, true);
    this.liquidInteractions?.forget(id);
  }

  /**
   * Your own splash, and your own air.
   *
   * Both read the PREDICTED water level rather than the snapshot's: the local
   * player's own body is simulated here, so taking it from the wire would land
   * their splash and their gasp a round trip after they felt the water.
   */
  emitLocalCrossing(v2Client: V2NetworkClient | null, dead = false): void {
    if (!v2Client) return;

    const state = v2Client.getState();
    const movement = v2Client.getMovementState();

    // Jumppad launch, on the rising edge. The profile holds the flag for as
    // long as the player overlaps the pad — velocity replacement is idempotent
    // so replays stay correct — which would otherwise retrigger the sound every
    // step of the launch. Played from prediction, like the splash above, so it
    // lands on the frame the player feels the kick rather than a round trip
    // later.
    if (movement.jumppadLaunch && !this._wasJumppadLaunching) {
      playJumppadLaunch(state.position, true);
    }
    this._wasJumppadLaunching = movement.jumppadLaunch;

    this.liquidInteractions?.notify("local", movement.waterLevel, "water", state.position, state.velocity.y, true);

    // The dead don't breathe. Prediction keeps sinking the body, so the mirror
    // went on gasping and gurgling over the corpse, a whole S&D round (L4).
    if (dead) return;
    const dt = Math.min(0.1, (EngineStore.LastCreatedEngine?.getDeltaTime() ?? 16) / 1000);
    this.airTracker?.update(movement.waterLevel, dt);
  }

  /** How submerged the camera is, 0-1. Read by the viewmodel to float the gun. */
  get cameraSubmersion(): number {
    return this.underwaterView?.submersionAmount ?? 0;
  }
}
