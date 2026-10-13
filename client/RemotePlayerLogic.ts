/**
 * RemotePlayerLogic — the decisions RemotePlayerRenderer makes from snapshot
 * data, kept free of Babylon so they can be tested without a scene.
 */

import type { EntitySnapshot, InterpolatedEntity } from "../../../engine/network/client/SnapshotBuffer";
import type { GameState } from "../../../engine/network/core/GameState";
import { isClientKey } from "../ClientEntityKey";
import type { PlayerTeamSlot } from "./PlayerModelVisualSettings";

// ─── Animation derivation constants ─────────────────────────────
export const IDLE_SPEED_THRESHOLD = 50;

/**
 * Below this 3-D speed a swimmer is treading rather than swimming.
 *
 * Lower than the walking threshold because a swimmer with no input still
 * sinks at 60 u/s, and that drift must not read as swimming — otherwise a
 * motionless player would never show the treading clip.
 */
export const SWIM_IDLE_SPEED_THRESHOLD = 70;
export const RUN_SPEED_THRESHOLD = 300;

/**
 * Remote players' movement state from one snapshot, keyed by client entity id.
 * The local player and non-player entities (projectiles, dropped weapons) are
 * left out, as is any entity without a position.
 */
export function extractEntities(state: GameState, localEntityId: string): Map<string, EntitySnapshot> {
  const entities = new Map<string, EntitySnapshot>();
  for (const [entityId, entity] of state.entities) {
    if (entityId === localEntityId) continue;
    if (!isClientKey(entityId)) continue;

    const transform = entity.getComponent("transform") as any;
    const velocity = entity.getComponent("velocity") as any;
    const movementState = entity.getComponent("movementState") as any;
    const powerups = entity.getComponent("powerups") as { mask?: number } | undefined;

    if (!transform?.position) continue;

    entities.set(entityId, {
      x: transform.position.x,
      y: transform.position.y,
      z: transform.position.z,
      yaw: transform.rotation?.y ?? 0,
      pitch: transform.rotation?.x ?? 0,
      vx: velocity?.linear?.x ?? velocity?.x ?? 0,
      vy: velocity?.linear?.y ?? velocity?.y ?? 0,
      vz: velocity?.linear?.z ?? velocity?.z ?? 0,
      grounded: velocity?.grounded ?? true,
      crouching: movementState?.isCrouching ?? false,
      sliding: movementState?.isSliding ?? false,
      wallJumping: movementState?.wallJumpState === "charging",
      crouchViewOffset: movementState?.crouchViewOffset ?? 0,
      powerupMask: powerups?.mask ?? 0,
      waterLevel: movementState?.waterLevel ?? 0,
      onLadder: movementState?.onLadder ?? false,
    });
  }
  return entities;
}

/**
 * Record each player's team from a snapshot roster into `teams` (a player with
 * no team is "ffa"). Returns the local player's team when the roster names the
 * local player (null when that player has no team), or undefined when it does not.
 */
export function applyRoster(
  teams: Map<string, string>,
  players: Iterable<{ entityId: string; team?: string }>,
  localEntityId: string,
): string | null | undefined {
  let localTeam: string | null | undefined;
  for (const player of players) {
    teams.set(player.entityId, player.team || "ffa");
    // Our own side comes from the same roster, so ally/enemy stays correct
    // through a side swap without anyone having to push it in.
    if (player.entityId === localEntityId) localTeam = player.team || null;
  }
  return localTeam;
}

/**
 * Legacy alpha/bravo names for older cosmetic effects. Allies are alpha and
 * enemies bravo; with no sides, the entity id picks one so it stays stable.
 */
export function legacyTeamColor(slot: PlayerTeamSlot, entityId: string): "alpha" | "bravo" {
  if (slot === "ally") return "alpha";
  if (slot === "enemy") return "bravo";
  const hash = entityId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return hash % 2 === 0 ? "alpha" : "bravo";
}

/**
 * The distance at which a body `bodyHeight` tall covers `minPixels` of screen
 * height, squared. 0 (pause nothing) whenever it cannot be measured: no field of
 * view, a non-perspective camera (`mode` other than 0), or no render height.
 */
export function animationLodRadiusSq(
  fov: number | undefined,
  mode: number | undefined,
  renderHeight: number,
  bodyHeight: number,
  minPixels: number,
): number {
  if (!fov || !Number.isFinite(fov) || fov <= 0) return 0;
  // Perspective only: an orthographic camera's projected size does not fall
  // off with distance, so the whole premise is absent.
  if (mode !== undefined && mode !== 0) return 0;
  if (!renderHeight) return 0;

  // pixels = worldHeight / distance * renderHeight / (2 tan(fov/2))
  const radius = (bodyHeight * renderHeight) / (2 * Math.tan(fov / 2) * minPixels);
  return Number.isFinite(radius) ? radius * radius : 0;
}

/** A frustum plane as Babylon stores it: inside when `normal · p + d >= 0`. */
export interface FrustumPlaneLike {
  normal: { x: number; y: number; z: number };
  d: number;
}

/**
 * Whether a sphere touches the frustum. Conservative: a sphere just beyond a
 * corner (outside two planes, inside each) still counts as visible, which only
 * ever keeps work running, never hides a body.
 */
export function sphereInFrustum(planes: readonly FrustumPlaneLike[], x: number, y: number, z: number, radius: number) {
  for (const { normal, d } of planes) {
    if (normal.x * x + normal.y * y + normal.z * z + d < -radius) return false;
  }
  return true;
}

/**
 * Derive animation name from interpolated network data.
 * Uses velocity, grounded state, and yaw — all available from SnapshotBuffer.
 */
export function deriveAnimation(interp: InterpolatedEntity): string {
  // Walljump — player is on a wall, play wallrun animation
  // Check BEFORE grounded/airborne since walljump happens while !grounded
  if (interp.wallJumping) return "walljump";

  // Swimming — must be checked before the airborne rule, because a swimmer
  // is ungrounded and would otherwise read as mid-jump for as long as they
  // stayed in the water. Moving lays the body flat; treading keeps it
  // upright, which is also the split the swim hull follows.
  if ((interp.waterLevel ?? 0) >= 2) {
    const swimSpeed = Math.sqrt(interp.vx * interp.vx + interp.vy * interp.vy + interp.vz * interp.vz);
    return swimSpeed < SWIM_IDLE_SPEED_THRESHOLD ? "swim_idle" : "swim";
  }

  // Climbing — checked before the airborne rule for the same reason as
  // swimming: a climber is ungrounded and would otherwise read as mid-jump
  // the whole way up. The clip's playback is driven by climb direction in
  // applyAnimation, so one clip covers going up and coming down.
  if (interp.onLadder) return "climb";

  // Airborne — use jump for entire air time (Warsow-style)
  if (!interp.grounded) return "jump";

  // Crouchslide — takes priority over walk/run/strafe
  if (interp.sliding) {
    return "slide";
  }

  const speed = Math.sqrt(interp.vx * interp.vx + interp.vz * interp.vz);

  // Crouching (not sliding) — use crouch walk animations
  if (interp.crouching) {
    if (speed < IDLE_SPEED_THRESHOLD) return "crouch_walk"; // Frozen first frame = crouch idle

    const fwdX = Math.sin(interp.yaw);
    const fwdZ = Math.cos(interp.yaw);
    const rightX = fwdZ;
    const rightZ = -fwdX;
    const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
    const rightDot = rightX * interp.vx + rightZ * interp.vz;

    if (Math.abs(rightDot) > Math.abs(forwardDot) * 1.5) {
      return rightDot > 0 ? "crouch_strafe_l" : "crouch_strafe_r";
    }
    return "crouch_walk"; // Backward handled by negative speedRatio
  }

  // Idle
  if (speed < IDLE_SPEED_THRESHOLD) return "idle";

  // Strafe detection
  const fwdX = Math.sin(interp.yaw);
  const fwdZ = Math.cos(interp.yaw);
  const rightX = fwdZ;
  const rightZ = -fwdX;

  const forwardDot = fwdX * interp.vx + fwdZ * interp.vz;
  const rightDot = rightX * interp.vx + rightZ * interp.vz;

  if (Math.abs(rightDot) > Math.abs(forwardDot) * 1.5) {
    return rightDot > 0 ? "strafe_l" : "strafe_r";
  }

  // Run vs walk
  return speed > RUN_SPEED_THRESHOLD ? "run" : "walk";
}
