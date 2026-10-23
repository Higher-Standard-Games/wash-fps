import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { Scene } from "@babylonjs/core/scene";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { initializeEntityDefs } from "../shared/entities";
import { WEAPONS } from "../shared/entities/definitions/weapons/WeaponsTable";

export async function preloadFPSWeapons(
  scene: Scene,
  camera: FreeCamera,
  onProgress?: (id: string) => void,
): Promise<void> {
  initializeEntityDefs();
  const view = getWeaponViewManager();
  view.init(scene, camera);
  await view.preloadWeapons(
    Object.values(WEAPONS).map((weapon) => weapon.id),
    onProgress,
  );
}
