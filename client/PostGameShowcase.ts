/**
 * PostGameShowcase — the winner's player model presented during the post-game
 * screen (docs/research/post_game_screen.md §7, first slice of the Face-Off).
 *
 * v1: spawns a detached copy of the winning player's model (team tint/outline
 * resolve locally per viewer, so it's automatically personalized) holding their
 * last-known weapon, placed in front of the local camera facing it. Disposed
 * when the next warmup begins.
 *
 * The placement is deliberately camera-relative (not a fixed map spot) so it
 * works on every map with zero authoring; the background-camera work (§8) will
 * replace this with the diorama/vista composition later.
 */

import type { PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";

/** Distance in front of the camera to place the model (world/Quake units). */
const SHOWCASE_DISTANCE = 150;
/** Camera eye sits ~this far above the entity origin the model spawner
 *  expects. Empirically tuned: 28 (nominal standing view height) sank the
 *  model knee-deep into the floor. */
const EYE_TO_ORIGIN = 14;
/** Yaw offset from camera forward (radians) — stand the model in the LEFT
 *  third of the view; the post-game board occupies the right side. */
const SHOWCASE_ANGLE = -0.55; // ~31° left

let currentModel: PlayerModelInstance | null = null;
let generation = 0;

/**
 * Show the winner's model in front of the local camera. Safe to call with
 * missing pieces (no renderer / unknown entity) — it just does nothing.
 */
export async function startPostGameShowcase(
  renderer: RemotePlayerRenderer | null,
  winnerEntityId: string | null,
  weaponId: string | null,
): Promise<void> {
  stopPostGameShowcase();
  if (!renderer || !winnerEntityId) {
    console.log(`[PostGameShowcase] skipped — renderer=${!!renderer} entityId=${winnerEntityId}`);
    return;
  }

  const gen = ++generation;

  const cam = CameraSystem.getInstance().getCamera() as {
    position?: { x: number; y: number; z: number };
    rotation?: { y?: number };
  } | null;
  if (!cam?.position) {
    console.log("[PostGameShowcase] skipped — no camera");
    return;
  }

  // Stand the model left-forward of the camera (the board sits on the right).
  const camYaw = cam.rotation?.y ?? 0;
  const placeYaw = camYaw + SHOWCASE_ANGLE;
  // Babylon left-handed: forward = (sin(yaw), 0, cos(yaw)).
  const x = cam.position.x + Math.sin(placeYaw) * SHOWCASE_DISTANCE;
  const z = cam.position.z + Math.cos(placeYaw) * SHOWCASE_DISTANCE;
  const y = cam.position.y - EYE_TO_ORIGIN;
  // Face the camera exactly (yaw from model position back to the camera).
  const facingCameraYaw = Math.atan2(cam.position.x - x, cam.position.z - z);

  console.log(
    `[PostGameShowcase] spawning winner model: entity=${winnerEntityId} weapon=${weaponId ?? "none"} at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`,
  );
  const model = await renderer.createDetachedModelAtAsync(winnerEntityId, x, y, z, facingCameraYaw);
  if (!model) {
    console.warn("[PostGameShowcase] model creation returned null");
    return;
  }

  // A newer showcase/stop superseded us while the model loaded.
  if (gen !== generation) {
    disposeModel(model);
    return;
  }
  currentModel = model;
  console.log("[PostGameShowcase] winner model spawned");

  if (weaponId) {
    renderer
      .attachShowcaseWeapon(model, weaponId)
      .then(() => console.log(`[PostGameShowcase] weapon attached: ${weaponId}`))
      .catch((e) => console.warn("[PostGameShowcase] weapon attach failed", e));
  }

  // Victory dance! Random pick from whichever Mixamo dance clips are shipped
  // (missing clips are skipped at load; playAnimation returns false → the
  // model simply keeps its idle pose).
  try {
    const { DANCE_ANIMS, PlayerModelManager } = await import("../../../engine/animation/PlayerModelManager");
    const dances = [...DANCE_ANIMS].sort(() => Math.random() - 0.5);
    for (const dance of dances) {
      if (PlayerModelManager.playAnimationOn(model, dance)) {
        console.log(`[PostGameShowcase] victory dance: ${dance}`);
        break;
      }
    }
  } catch {
    /* dances are a flourish — idle pose is fine */
  }
}

/** Remove the showcase model (next warmup / disconnect). Idempotent. */
export function stopPostGameShowcase(): void {
  generation++;
  if (currentModel) {
    disposeModel(currentModel);
    currentModel = null;
  }
}

function disposeModel(model: PlayerModelInstance): void {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: best-effort cleanup across model shapes
    const m = model as any;
    m.attachedWeapon?.dispose?.(false, true);
    m.masterGroup?.stop?.();
    m.masterGroup?.dispose?.();
    m.mesh?.dispose?.();
    m.skeleton?.dispose?.();
    m.anchor?.dispose?.();
  } catch {
    /* best-effort */
  }
}
