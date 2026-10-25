import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { Scene } from "@babylonjs/core/scene";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { initializeEntityDefs } from "../shared/entities";
import { WEAPONS } from "../shared/entities/definitions/weapons/WeaponsTable";

export async function preloadFPSWeapons(
  scene: Scene,
  camera: FreeCamera,
  onProgress?: (id: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  initializeEntityDefs();
  const view = getWeaponViewManager();
  view.init(scene, camera);
  await view.preloadWeapons(
    Object.values(WEAPONS).map((weapon) => weapon.id),
    onProgress,
    signal,
  );
  // The projectiles those weapons fire: their models and shaders are ready
  // before the match, not built on each type's first shot
  const projectiles = new Set<string>();
  for (const weapon of Object.values(WEAPONS)) {
    if (weapon.projectileId) projectiles.add(weapon.projectileId);
    if (weapon.chargedProjectileId) projectiles.add(weapon.chargedProjectileId);
  }
  await getProjectileManager().prepare(scene, [...projectiles], signal);
}
