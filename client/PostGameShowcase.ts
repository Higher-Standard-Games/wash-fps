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
const SHOWCASE_DISTANCE = 140;
/** Camera eye sits ~this far above the entity origin the model spawner expects. */
const EYE_TO_ORIGIN = 28;

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
  if (!renderer || !winnerEntityId) return;

  const gen = ++generation;

  const cam = CameraSystem.getInstance().getCamera() as {
    position?: { x: number; y: number; z: number };
    rotation?: { y?: number };
  } | null;
  if (!cam?.position) return;

  const camYaw = cam.rotation?.y ?? 0;
  // Babylon left-handed: forward = (sin(yaw), 0, cos(yaw)).
  const x = cam.position.x + Math.sin(camYaw) * SHOWCASE_DISTANCE;
  const z = cam.position.z + Math.cos(camYaw) * SHOWCASE_DISTANCE;
  const y = cam.position.y - EYE_TO_ORIGIN;
  const facingCameraYaw = camYaw + Math.PI;

  const model = await renderer.createDetachedModelAtAsync(winnerEntityId, x, y, z, facingCameraYaw);
  if (!model) return;

  // A newer showcase/stop superseded us while the model loaded.
  if (gen !== generation) {
    disposeModel(model);
    return;
  }
  currentModel = model;

  if (weaponId) {
    renderer.attachShowcaseWeapon(model, weaponId).catch(() => {});
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
