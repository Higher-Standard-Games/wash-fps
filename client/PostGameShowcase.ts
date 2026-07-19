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

import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";

/** Distance in front of the camera to place the model (world/Quake units).
 *  200u frames the full body with headroom (150 filled the screen edge-to-edge). */
const SHOWCASE_DISTANCE = 200;
/** Fixed screen anchor for the model's origin (feet), as a fraction of the
 *  render viewport — so the winner always lands in the SAME on-screen spot
 *  regardless of window size, aspect, or where the camera happened to face at
 *  match end (#5). X from the left, Y from the top. The post-game board sits on
 *  the right, so the model anchors into the padded upper-left. Tune to taste. */
const SHOWCASE_SCREEN_X = 0.22;
const SHOWCASE_SCREEN_Y = 0.72;
/** Never place the model closer than this (nose-to-wall endings). */
const SHOWCASE_MIN_DISTANCE = 60;
/** Keep the model this far in front of a blocking wall. */
const SHOWCASE_WALL_PADDING = 24;

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
    getScene?: () => import("@babylonjs/core/scene").Scene;
  } | null;
  if (!cam?.position) {
    console.log("[PostGameShowcase] skipped — no camera");
    return;
  }
  const scene = cam.getScene?.();
  if (!scene) {
    console.log("[PostGameShowcase] skipped — no scene");
    return;
  }

  const [{ Ray }, { Vector3, Matrix }] = await Promise.all([
    import("@babylonjs/core/Culling/ray"),
    import("@babylonjs/core/Maths/math.vector"),
  ]);

  // Place the model along a picking ray through a FIXED screen anchor, so it
  // always lands in the same on-screen spot regardless of window size/FOV or
  // where the camera faced at match end (#5) — not a camera-relative yaw offset.
  const engine = scene.getEngine();
  const anchorX = engine.getRenderWidth() * SHOWCASE_SCREEN_X;
  const anchorY = engine.getRenderHeight() * SHOWCASE_SCREEN_Y;
  const dir = scene.createPickingRay(anchorX, anchorY, Matrix.Identity(), cam as unknown as Camera).direction;
  const origin = new Vector3(cam.position.x, cam.position.y, cam.position.z);

  // Wall clamp: the player can end the match nose-to-wall, which would put the
  // spot inside/behind geometry ("model missing"). Raycast along the placement
  // ray and pull the model in front of whatever it hits.
  let distance = SHOWCASE_DISTANCE;
  const hit = scene.pickWithRay(new Ray(origin, dir, SHOWCASE_DISTANCE), (mesh) => {
    if (mesh.isPickable === false) return false;
    const metadata = mesh.metadata as { mapOwned?: boolean } | null;
    return (
      metadata?.mapOwned === true || mesh.name.startsWith("bsp_") || mesh.name === "brush" || mesh.name === "patch"
    );
  });
  if (hit?.hit && hit.pickedPoint) {
    const hitDistance = Vector3.Distance(origin, hit.pickedPoint);
    distance = Math.min(distance, Math.max(SHOWCASE_MIN_DISTANCE, hitDistance - SHOWCASE_WALL_PADDING));
    console.log(`[PostGameShowcase] wall at ${hitDistance.toFixed(0)} — clamped to ${distance.toFixed(0)}`);
  }

  const x = cam.position.x + dir.x * distance;
  const y = cam.position.y + dir.y * distance;
  const z = cam.position.z + dir.z * distance;
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

  // Self-lit hero styling: the camera-relative spawn can land in a dark part of
  // the map, where a scene-lit model renders as a black silhouette. Force
  // fullbright emissive (team tint kept) so the winner always reads.
  renderer.applyShowcaseVisualStyle(model, winnerEntityId);

  // Anti-culling: the model is a SKINNED mesh playing an animation — Babylon
  // frustum-culls by the static bind-pose bounds, which can hide the whole
  // model depending on camera angle (the known "stale bounds culling" class;
  // the live renderer forces this every frame, a detached model gets it once).
  model.mesh.alwaysSelectAsActiveMesh = true;
  model.mesh.isVisible = true;
  for (const child of model.mesh.getChildMeshes()) {
    child.alwaysSelectAsActiveMesh = true;
    child.isVisible = true;
  }

  // When a wall forced the model closer than the nominal distance, scale it
  // down proportionally — otherwise a close model fills the whole screen.
  if (distance < SHOWCASE_DISTANCE) {
    const shrink = Math.max(0.45, distance / SHOWCASE_DISTANCE);
    model.anchor.scaling.setAll(shrink);
    console.log(`[PostGameShowcase] close placement — model scaled to ${shrink.toFixed(2)}`);
  }
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
