/**
 * ServerProjectiles — client bookkeeping for server-driven projectiles (Q3
 * style): which ones have visuals, their weapon defIds, and the snapshot
 * buffer they are interpolated from each frame.
 *
 * Moved out of Game unchanged. The event handlers fill these through Game's
 * event context, so the three collections stay public.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { type InterpolatedEntity, SnapshotBuffer } from "../../../engine/network/client/SnapshotBuffer";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import type { LiquidInteractionSystem } from "../liquid/client/LiquidInteractionSystem";

export class ServerProjectiles {
  /** Maps server projectile entity ID (e.g. 'proj_10001') → weapon defId */
  readonly defIds: Map<string, string> = new Map();
  /** Server entity ID → the last snapshot tick it was in, so its defId is kept while out of view */
  readonly seenTicks: Map<string, number> = new Map();
  /** Set of server entity IDs that already have client-side visuals spawned */
  readonly active: Set<string> = new Set();
  /** SnapshotBuffer for projectile entity interpolation (Q3-style lerp between snapshots) */
  readonly buffer: SnapshotBuffer = new SnapshotBuffer();

  // Per-frame scratch, overwritten for each projectile
  private readonly sample = {} as InterpolatedEntity;
  private readonly position = new Vector3();
  private readonly velocity = new Vector3();
  private readonly point = { x: 0, y: 0, z: 0 };

  /**
   * Per-frame interpolated rendering of server-driven projectiles.
   * Samples the SnapshotBuffer for each active projectile entity,
   * giving smooth lerp between two snapshots (same as remote players).
   */
  render(liquidInteractions: LiquidInteractionSystem | null): void {
    if (this.active.size === 0) return;
    const projMgr = getProjectileManager();
    // One bracket search for the frame and scratch vectors, rather than a
    // fresh sample and two Vector3s per projectile per frame
    this.buffer.beginFrame();
    const { sample, position, velocity, point } = this;
    for (const entityId of this.active) {
      const interp = this.buffer.sampleInFrame(entityId, sample);
      if (!interp) continue;
      position.set(interp.x, interp.y, interp.z);
      velocity.set(interp.vx, interp.vy, interp.vz);
      projMgr.updateServerPosition(entityId, position, velocity);

      // A rocket into a pool used to land in silence: water is NONSOLID, so
      // nothing impacts it and no event fires. This loop already has the
      // per-frame position, which is all a crossing needs.
      point.x = interp.x;
      point.y = interp.y;
      point.z = interp.z;
      liquidInteractions?.notifyProjectile(entityId, point, Math.hypot(interp.vx, interp.vy, interp.vz));
    }
  }

  /**
   * Clear every visual and the stale interpolation (tab return). Types are
   * kept, and forgetting which ids are drawn lets the next snapshot draw the
   * ones still in flight again, mid-flight.
   */
  dropVisuals(): void {
    try {
      getProjectileManager().clear();
    } catch {
      /* not initialized */
    }
    this.active.clear();
    this.buffer.flush();
  }

  /** Entity ids and interpolation ticks belong to one server session. */
  reset(forgetLiquid: (entityId: string) => void): void {
    for (const entityId of this.active) {
      getProjectileManager().despawnByEntityId(entityId);
      forgetLiquid(entityId);
    }
    this.active.clear();
    this.defIds.clear();
    this.seenTicks.clear();
    this.buffer.reset();
  }
}
