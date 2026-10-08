/**
 * PostGameShowcase — the winner's player model presented during the post-game
 * screen (docs/research/post_game_screen.md §7, first slice of the Face-Off).
 *
 * Spawns a detached copy of the winning player's model (team tint/outline resolve
 * locally per viewer, so it's automatically personalized) holding their last-known
 * weapon, dropped at a clear world spot in front of the frozen camera. Disposed
 * when the next warmup begins.
 *
 * A dedicated "diorama" camera then frames the winner as a centered, straight-on
 * hero shot composed relative to the MODEL (not the death spot), so the shot looks
 * the same every match regardless of where the fight ended. The map remains the
 * backdrop; a fuller vista/backdrop composition (§8) is still future work.
 */

import type { Camera } from "@babylonjs/core/Cameras/camera";
import { disposePlayerModel, type PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";
import { CameraSystem } from "../../../engine/camera/CameraSystem";
import type { RemotePlayerRenderer } from "./RemotePlayerRenderer";

/** Distance in front of the camera to place the model (world/Quake units).
 *  200u frames the full body with headroom (150 filled the screen edge-to-edge). */
const SHOWCASE_DISTANCE = 200;
/** Screen anchor for WHERE IN THE WORLD to drop the model — a fraction of the
 *  render viewport traced from the frozen camera. Centered/straight-ahead now
 *  gives the most open spot; the dedicated diorama camera (below) does the actual
 *  on-screen framing, so this only picks a clear world position. */
const SHOWCASE_SCREEN_X = 0.5;
const SHOWCASE_SCREEN_Y = 0.55;
/** Never place the model closer than this (nose-to-wall endings). */
const SHOWCASE_MIN_DISTANCE = 60;
/** Keep the model this far in front of a blocking wall. */
const SHOWCASE_WALL_PADDING = 24;

// ── Diorama camera ────────────────────────────────────────────────────
// A dedicated camera frames the winner as a CENTERED, straight-on hero shot,
// placed relative to the MODEL (not the death spot) so the composition is
// identical every match — no more "model in a weird map position" (#5). It sits
// in front of the model, where the player was standing (clear space), so it
// never buries itself in a wall. Tune these live in playtest.
/** Camera distance from the model, in front of it (clamped to the clear space). */
const DIORAMA_DISTANCE = 175;
/** Camera height above the model's origin. */
const DIORAMA_EYE_HEIGHT = 40;
/** Look-at height above the model's origin (torso). Equal-ish to eye = level shot. */
const DIORAMA_LOOK_HEIGHT = 36;
/** Vertical field of view (radians). */
const DIORAMA_FOV = 0.8;

let currentModel: PlayerModelInstance | null = null;
let generation = 0;
let dioramaCamera: Camera | null = null;
let savedActiveCameras: Camera[] | null = null;

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

  // Dedicated diorama camera: a centered, straight-on hero shot framed relative
  // to the MODEL, so the winner is composed identically every match regardless of
  // where the fight ended. It sits in front of the model (where the player was
  // standing = clear space), clamped to the available distance so it can't clip a
  // wall behind it. Swapping scene.activeCameras also drops the viewmodel overlay,
  // so the gun isn't floating in the hero shot.
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  if (gen !== generation) {
    disposeModel(model);
    currentModel = null;
    return;
  }
  const faceX = cam.position.x - x;
  const faceZ = cam.position.z - z;
  const faceLen = Math.hypot(faceX, faceZ) || 1;
  const camDist = Math.min(DIORAMA_DISTANCE, distance);
  const dioramaPos = new Vector3(
    x + (faceX / faceLen) * camDist,
    y + DIORAMA_EYE_HEIGHT,
    z + (faceZ / faceLen) * camDist,
  );
  const diorama = new FreeCamera("postgame_diorama", dioramaPos, scene);
  diorama.setTarget(new Vector3(x, y + DIORAMA_LOOK_HEIGHT, z));
  diorama.fov = DIORAMA_FOV;
  diorama.minZ = 1;
  diorama.maxZ = 10000;
  diorama.inputs.clear();
  savedActiveCameras = scene.activeCameras ? [...scene.activeCameras] : null;
  scene.activeCameras = [diorama];
  scene.activeCamera = diorama;
  dioramaCamera = diorama;
  console.log("[PostGameShowcase] winner model spawned + diorama camera framed");

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
  removeDioramaCamera();
  if (currentModel) {
    disposeModel(currentModel);
    currentModel = null;
  }
}

/** Restore the gameplay cameras and tear down the diorama camera. Idempotent. */
function removeDioramaCamera(): void {
  if (!dioramaCamera) return;
  const scene = dioramaCamera.getScene();
  try {
    // Restore the [main, weapon] pair BEFORE disposing so the scene always has a
    // valid active camera (disposing the current active camera mid-render throws).
    if (savedActiveCameras && savedActiveCameras.length > 0) {
      scene.activeCameras = savedActiveCameras;
      scene.activeCamera = savedActiveCameras[0];
    }
  } catch {
    /* scene may be tearing down */
  }
  dioramaCamera.dispose();
  dioramaCamera = null;
  savedActiveCameras = null;
}

function disposeModel(model: PlayerModelInstance): void {
  try {
    // The shared path: the gun goes with the loader leftovers bound to it.
    disposePlayerModel(model);
  } catch {
    /* best-effort */
  }
}
