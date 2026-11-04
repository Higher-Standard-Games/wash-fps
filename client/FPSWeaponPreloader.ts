import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { Scene } from "@babylonjs/core/scene";
import { sceneGpuReady, waitForGpuCondition } from "../../../engine/loader/map/GpuPreparation";
import { warmHiddenMeshes } from "../../../engine/rendering/PipelineWarmup";
import { getHitscanEffects } from "../../../engine/weapon/HitscanEffects";
import { getPointLightPool } from "../../../engine/weapon/PointLightPool";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import type { WeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { initializeEntityDefs } from "../shared/entities";
import { WEAPONS } from "../shared/entities/definitions/weapons/WeaponsTable";
import { DamageNumbers } from "./DamageNumbers";
import { GibSystem } from "./GibSystem";
import { TeleportEffect } from "./TeleportEffect";

/**
 * Compile one effect's shader ahead of play. A failure only costs that effect
 * a compile on first use, so it is reported and the load goes on; a cancelled
 * load still stops here.
 */
async function warmEffect(name: string, prepare: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  try {
    await prepare();
  } catch (error) {
    signal?.throwIfAborted();
    console.warn(`[FPSWeaponPreloader] ${name} shader warm-up failed; it compiles on first use`, error);
  }
}

/**
 * Load every weapon's view model and compile what play draws, behind the
 * loading screen. `onProgress` hears each finished step as done of total.
 */
export async function preloadFPSWeapons(
  scene: Scene,
  camera: FreeCamera,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  preparedView?: WeaponViewManager,
): Promise<void> {
  initializeEntityDefs();
  // The pool's lights live in the gameplay light cluster, which every lit
  // material includes once it exists: weapons compiled before it would compile
  // again when first held in play
  getPointLightPool().init(scene);
  const view = preparedView ?? getWeaponViewManager();
  view.init(scene, camera);
  const weaponIds = Object.values(WEAPONS).map((weapon) => weapon.id);
  // Each weapon, the projectiles, the five effects and the final GPU check
  const total = weaponIds.length + 7;
  let done = 0;
  const step = () => onProgress?.(++done, total);
  onProgress?.(0, total);
  let started = 0;
  // preloadWeapons names each weapon as it starts it: the one before it is done
  await view.preloadWeapons(weaponIds, () => (started++ > 0 ? step() : undefined), signal);
  step();
  // The projectiles those weapons fire: their models and shaders are ready
  // before the match, not built on each type's first shot
  const projectiles = new Set<string>();
  for (const weapon of Object.values(WEAPONS)) {
    if (weapon.projectileId) projectiles.add(weapon.projectileId);
    if (weapon.chargedProjectileId) projectiles.add(weapon.chargedProjectileId);
  }
  await getProjectileManager().prepare(scene, [...projectiles], signal);
  step();
  // What a fight draws first: slash trails, pellets, damage numbers, the
  // teleport afterimage and gibs. Their shaders compile here, not in the first fight.
  await warmEffect("slash trail", () => view.prepareEffectShaders(signal), signal);
  step();
  await warmEffect("pellets", () => getHitscanEffects().preparePelletShader(signal), signal);
  step();
  // Damage numbers and gibs are made per fight; the ones made here stay until
  // the hidden-mesh draw below has drawn them too
  const numbers = DamageNumbers.create(scene);
  const gibs = GibSystem.create(scene);
  try {
    await warmEffect("damage numbers", () => numbers.prepareShaders(signal), signal);
    step();
    await warmEffect("teleport afterimage", () => TeleportEffect.getInstance().prepare(scene, signal), signal);
    step();
    await warmEffect("gibs", () => gibs.prepareShaders(signal), signal);
    step();
    // Compiled is not drawn: WebGPU builds a render pipeline on a mesh's first
    // draw. Everything hidden now (unheld weapons, pooled effects, projectile
    // models, these numbers and gibs) draws here for a few frames, so a
    // fight's first rocket, gib or damage number does not stall a frame.
    await warmEffect("render pipelines", async () => void (await warmHiddenMeshes(scene, signal)), signal);
  } finally {
    numbers.dispose();
    gibs.dispose();
  }
  await waitForGpuCondition(scene, () => sceneGpuReady(scene), "FPS presentation", signal, 15000);
  step();
}
