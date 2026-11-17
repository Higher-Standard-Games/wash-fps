/**
 * The client's projectiles, kept in step with the server's: each `proj_`
 * entity in a snapshot gets a visual the first time it appears (its type from
 * the `projectile_spawn` event), flies on the interpolation buffer, and is
 * despawned when it leaves the snapshot. Shared by live play and demo playback.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CameraSystem } from "../../../engine/camera";
import { log } from "../../../engine/core/Log";
import type { EntitySnapshot, SnapshotBuffer } from "../../../engine/network/client/SnapshotBuffer";
import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { IComponent } from "../../../engine/network/core/Component";
import type { GameState } from "../../../engine/network/core/GameState";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import { DEFAULT_PHYSICS_TICK_RATE } from "../../../shared/server/simulation/physics/constants";

/** Mutable projectile-sync collections, shared by live play and demo playback. */
export interface ProjectileSyncState {
  /** Optional first-person presentation; demos/free cameras can omit it. */
  muzzleForShot?: (position: Vector3, velocity: Vector3) => Vector3 | null;
  /** Server entity ids we've spawned a visual for */
  active: Set<string>;
  /** proj_ entityId → defId (from projectile_spawn events) */
  defIds: Map<string, string>;
  /**
   * proj_ entityId → the last snapshot tick it was in (or, before its first, the
   * tick its type was first held). A projectile out of view keeps its type until
   * it has been gone longer than any projectile lives.
   */
  seenTicks: Map<string, number>;
  /** Interpolation buffer for smooth in-flight motion */
  buffer: SnapshotBuffer;
  /** Drop a despawned projectile's liquid tracking, if the game is running one. */
  forgetLiquid?: (entityId: string) => void;
}

/**
 * How long a projectile type is kept after the projectile was last in a
 * snapshot: the longest projectile lifetime (10 s, `ProjectileSystem`) and a second.
 */
const PROJECTILE_FORGET_TICKS = 11 * DEFAULT_PHYSICS_TICK_RATE;

/**
 * Draw the projectiles a snapshot holds: spawn a visual for each new one, feed
 * the interpolation buffer, and despawn those that left it.
 */
export function processProjectileEntities(state: GameState, sync: ProjectileSyncState, serverLocalTime?: number): void {
  const projEntities = new Map<string, EntitySnapshot>();
  const aliveThisSnapshot = new Set<string>();

  for (const [entityId, entity] of state.entities) {
    if (!entityId.startsWith("proj_")) continue;
    aliveThisSnapshot.add(entityId);

    const posComp = entity.getComponent<IComponent & Vec3>("position");
    // The decoder's velocity carries its linear velocity as plain x/y/z too.
    const velComp = entity.getComponent<IComponent & Vec3>("velocity");
    if (!posComp) continue;

    projEntities.set(entityId, {
      x: posComp.x,
      y: posComp.y,
      z: posComp.z,
      yaw: 0,
      vx: velComp?.x ?? 0,
      vy: velComp?.y ?? 0,
      vz: velComp?.z ?? 0,
      grounded: false,
      crouching: false,
      sliding: false,
      wallJumping: false,
    });

    const seenBefore = sync.seenTicks.has(entityId);
    sync.seenTicks.set(entityId, state.tick);

    if (!sync.active.has(entityId)) {
      const defId = sync.defIds.get(entityId);
      if (defId) {
        const projMgr = getProjectileManager();
        if (!projMgr.isInitialized()) {
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) projMgr.init(gameScene);
        }
        const pos = new Vector3(posComp.x, posComp.y, posComp.z);
        const vel = velComp ? new Vector3(velComp.x, velComp.y, velComp.z) : Vector3.Zero();
        // Only a new shot starts at a gun. One coming back into view is mid-flight.
        const muzzle = seenBefore ? null : sync.muzzleForShot?.(pos, vel);
        projMgr.spawnFromServer(entityId, defId, pos, vel, muzzle);
        sync.active.add(entityId);
      } else {
        // projectile_spawn is sent once, with the projectile's first snapshot,
        // and names its type. Without it the projectile flies with no model or trail.
        log.warnRateLimited(
          "ProjectileSync",
          `${entityId} is in snapshot ${state.tick} without its projectile_spawn event; it is not drawn`,
        );
      }
    }
  }

  // Push to interpolation buffer
  sync.buffer.push(state.tick, projEntities, serverLocalTime);

  // Despawn visuals for projectiles that disappeared. Gone from the snapshot is
  // either exploded or out of view (PVS), and the client cannot tell which, so
  // the type is kept: projectile_spawn is sent once, and without it a projectile
  // coming back into view would never be drawn again.
  for (const entityId of sync.active) {
    if (!aliveThisSnapshot.has(entityId)) {
      getProjectileManager().despawnByEntityId(entityId);
      sync.active.delete(entityId);
      // Drop its liquid tracking too, or a recycled entity id inherits a
      // "was in water" flag from a projectile that already exploded.
      sync.forgetLiquid?.(entityId);
    }
  }

  // Types are forgotten by age instead: projectile_impact carries no entity id.
  for (const entityId of sync.defIds.keys()) {
    const seen = sync.seenTicks.get(entityId);
    if (seen === undefined) {
      sync.seenTicks.set(entityId, state.tick);
    } else if (state.tick - seen > PROJECTILE_FORGET_TICKS) {
      sync.defIds.delete(entityId);
      sync.seenTicks.delete(entityId);
    }
  }
}
