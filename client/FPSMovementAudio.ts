import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AudioManager } from "../../../engine/AudioManager";
import type { MovementStateComponent } from "../../../engine/network/components/MovementStateComponent";
import type { TransformComponent } from "../../../engine/network/components/TransformComponent";
import type { VelocityComponent } from "../../../engine/network/components/VelocityComponent";
import type { GameState } from "../../../engine/network/core/GameState";
import { getCollisionManager } from "../../../engine/physics/CollisionManager";
import { CollisionMasks, SurfaceFlags } from "../../../engine/physics/ContentFlags";

const normalFootsteps = [
  "sounds/world/ft_step1.ogg",
  "sounds/world/ft_step2.ogg",
  "sounds/world/ft_step3.ogg",
] as const;
const metalFootsteps = [
  "sounds/world/ft_step_met1.ogg",
  "sounds/world/ft_step_met2.ogg",
  "sounds/world/ft_step_met3.ogg",
] as const;
const bobotJumps = ["sounds/players/bobot/jump_1.ogg", "sounds/players/bobot/jump_2.ogg"] as const;

/** Vertical units between ladder rung sounds. */
const LADDER_RUNG_SPACING = 44;

/** Warsow's own trigger_push sound, shipped in data0_000_nonfree_21pure.pk3. */
const jumppadLaunch = "sounds/world/jumppad.ogg";

export const FPS_MOVEMENT_SOUND_PATHS = [...normalFootsteps, ...metalFootsteps, ...bobotJumps, jumppadLaunch] as const;

/**
 * A jumppad throwing someone into the air.
 *
 * The profile reports `jumppadLaunch` on every step the player overlaps the
 * pad, because velocity replacement is idempotent and has to stay that way for
 * replay. Firing a one-shot off that flag is the caller's job — so this expects
 * to be called on the rising edge, not while the flag is held.
 */
export function playJumppadLaunch(position: { x: number; y: number; z: number }, local: boolean): void {
  playAtPlayer(jumppadLaunch, position, local, 0.75);
}

interface MovementAudioState {
  x: number;
  y: number;
  z: number;
  grounded: boolean;
  stepDistance: number;
  /** Vertical travel banked toward the next ladder rung. */
  climbDistance: number;
}

const movementStates = new Map<string, MovementAudioState>();
let footstepSequence = 0;
let jumpSequence = 0;
let cachedBsp: ReturnType<ReturnType<typeof getCollisionManager>["getBsp"]> = null;
let surfaceFlagsByTexture = new Map<string, number>();

export async function preloadFPSMovementAudio(): Promise<void> {
  await AudioManager.getInstance().preloadSfx(FPS_MOVEMENT_SOUND_PATHS);
}

export function resetFPSMovementAudio(): void {
  movementStates.clear();
  cachedBsp = null;
  surfaceFlagsByTexture.clear();
}

/**
 * Convert authoritative snapshot travel into location-aware steps. Distance,
 * rather than a wall-clock timer, keeps cadence attached to actual movement and
 * naturally accelerates during strafe-jumps.
 */
export function processFPSMovementAudio(state: GameState, localEntityId?: string): void {
  const alive = new Set<string>();

  for (const player of state.players.values()) {
    const entityId = player.entityId;
    const entity = state.entities.get(entityId);
    const transform = entity?.getComponent<TransformComponent>("transform");
    const velocity = entity?.getComponent<VelocityComponent>("velocity");
    if (!transform || !velocity) continue;
    alive.add(entityId);

    const position = transform.position;
    const previous = movementStates.get(entityId);
    if (!previous) {
      movementStates.set(entityId, {
        x: position.x,
        y: position.y,
        z: position.z,
        grounded: velocity.grounded,
        stepDistance: 0,
        climbDistance: 0,
      });
      continue;
    }

    const dx = position.x - previous.x;
    const dz = position.z - previous.z;
    const horizontalTravel = Math.hypot(dx, dz);
    const horizontalSpeed = Math.hypot(velocity.linear.x, velocity.linear.z);
    const movement = entity?.getComponent<MovementStateComponent>("movementState");
    const local = entityId === localEntityId;

    // A grounded -> rising edge is a jump, while teleports and seek jumps are
    // rejected by the travel cap below.
    if (previous.grounded && !velocity.grounded && velocity.linear.y > 60 && horizontalTravel < 256) {
      const path = bobotJumps[jumpSequence++ % bobotJumps.length];
      playAtPlayer(path, position, local, 0.72);
    }

    // Ladders get their own cadence off vertical travel: a climber is neither
    // grounded nor moving horizontally, so the footstep rules below never fire
    // for them. Rung spacing rather than stride length sets the interval.
    if (movement?.onLadder) {
      previous.climbDistance += Math.abs(position.y - previous.y);
      if (previous.climbDistance >= LADDER_RUNG_SPACING) {
        previous.climbDistance %= LADDER_RUNG_SPACING;
        playRungStep(position, local);
      }
      previous.stepDistance = 0;
    } else if (horizontalTravel > 256) {
      previous.climbDistance = 0;
      previous.stepDistance = 0;
    } else if (velocity.grounded && !movement?.isSliding && horizontalSpeed > 70) {
      previous.stepDistance += horizontalTravel;
      const stride = movement?.isCrouching ? 96 : horizontalSpeed > 500 ? 145 : 122;
      if (previous.stepDistance >= stride) {
        previous.stepDistance %= stride;
        playFootstep(position, local);
      }
    } else if (!velocity.grounded) {
      previous.stepDistance = 0;
    }

    previous.x = position.x;
    previous.y = position.y;
    previous.z = position.z;
    previous.grounded = velocity.grounded;
  }

  for (const entityId of movementStates.keys()) {
    if (!alive.has(entityId)) movementStates.delete(entityId);
  }
}

/**
 * A hand or boot finding the next rung.
 *
 * Ladders are metal, and the metal footstep bank is already loaded for every
 * map, so climbing needs no new asset. Quieter than a footstep: it is a grab,
 * not a full step onto a surface.
 */
function playRungStep(position: { x: number; y: number; z: number }, local: boolean): void {
  const path = metalFootsteps[footstepSequence++ % metalFootsteps.length];
  playAtPlayer(path, position, local, 0.38);
}

function playFootstep(position: { x: number; y: number; z: number }, local: boolean): void {
  const surfaceFlags = getGroundSurfaceFlags(position);
  if ((surfaceFlags & SurfaceFlags.NOSTEPS) !== 0) return;
  const bank = (surfaceFlags & SurfaceFlags.METALSTEPS) !== 0 ? metalFootsteps : normalFootsteps;
  const path = bank[footstepSequence++ % bank.length];
  playAtPlayer(path, position, local, 0.5);
}

function playAtPlayer(
  path: string,
  position: { x: number; y: number; z: number },
  local: boolean,
  volume: number,
): void {
  const audio = AudioManager.getInstance();
  if (local) audio.playSfx2D(path, volume, 2);
  else audio.playSfx3D(path, position, { volume, minDistance: 64, maxDistance: 1250 });
}

function getGroundSurfaceFlags(position: { x: number; y: number; z: number }): number {
  const collision = getCollisionManager();
  if (!collision.isInitialized()) return 0;
  refreshSurfaceIndex();

  const start = new Vector3(position.x, position.y, position.z);
  const end = new Vector3(position.x, position.y - 48, position.z);
  const trace = collision.trace(start, end, {
    radius: 1,
    height: 0,
    contentMask: CollisionMasks.PLAYERSOLID,
  });
  const texture = trace.hitTextureName?.toLowerCase();
  return texture ? (surfaceFlagsByTexture.get(texture) ?? 0) : 0;
}

function refreshSurfaceIndex(): void {
  const bsp = getCollisionManager().getBsp();
  if (bsp === cachedBsp) return;
  cachedBsp = bsp;
  surfaceFlagsByTexture = new Map(
    bsp?.textures.map((texture) => [texture.name.toLowerCase(), texture.surfaceFlags]) ?? [],
  );
}
