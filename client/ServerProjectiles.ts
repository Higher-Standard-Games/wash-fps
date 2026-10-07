/**
 * ServerProjectiles — client bookkeeping for server-driven projectiles (Q3
 * style): which ones have visuals, their weapon defIds, and the snapshot
 * buffer they are interpolated from each frame.
 *
 * Moved out of Game unchanged. The event handlers fill these through Game's
 * event context, so the three collections stay public.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SnapshotBuffer } from "../../../engine/network/client/SnapshotBuffer";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import type { LiquidInteractionSystem } from "../liquid/client/LiquidInteractionSystem";

export class ServerProjectiles {
  /** Maps server projectile entity ID (e.g. 'proj_10001') → weapon defId */
  readonly defIds: Map<string, string> = new Map();
  /** Set of server entity IDs that already have client-side visuals spawned */
  readonly active: Set<string> = new Set();
  /** SnapshotBuffer for projectile entity interpolation (Q3-style lerp between snapshots) */
  readonly buffer: SnapshotBuffer = new SnapshotBuffer();

  /**
   * Per-frame interpolated rendering of server-driven projectiles.
   * Samples the SnapshotBuffer for each active projectile entity,
   * giving smooth lerp between two snapshots (same as remote players).
   */
  render(liquidInteractions: LiquidInteractionSystem | null): void {
    const projMgr = getProjectileManager();
    for (const entityId of this.active) {
      const interp = this.buffer.sample(entityId);
      if (!interp) continue;
      projMgr.updateServerPosition(
        entityId,
        new Vector3(interp.x, interp.y, interp.z),
        new Vector3(interp.vx, interp.vy, interp.vz),
      );

      // A rocket into a pool used to land in silence: water is NONSOLID, so
      // nothing impacts it and no event fires. This loop already has the
      // per-frame position, which is all a crossing needs.
      liquidInteractions?.notifyProjectile(
        entityId,
        { x: interp.x, y: interp.y, z: interp.z },
        Math.hypot(interp.vx, interp.vy, interp.vz),
      );
    }
  }

  /** Entity ids and interpolation ticks belong to one server session. */
  reset(forgetLiquid: (entityId: string) => void): void {
    for (const entityId of this.active) {
      getProjectileManager().despawnByEntityId(entityId);
      forgetLiquid(entityId);
    }
    this.active.clear();
    this.defIds.clear();
    this.buffer.reset();
  }
}
