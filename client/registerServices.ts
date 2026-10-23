/** Install Washoi's engine adapters before scene/game initialization. */
export async function registerWashoiServices(): Promise<void> {
  const fpsModule = await import("../index");
  fpsModule.registerFpsEditorCatalog();
  const { registerFreeflyInput } = await import("../../../engine/camera/FreeflyInput");
  registerFreeflyInput(fpsModule.fpsFreeflyInput);
  const { registerGameMapEntities } = await import("../../../engine/loader/map/GameMapEntities");
  registerGameMapEntities(fpsModule.fpsMapEntities);
  const { registerWeaponIdResolver } = await import("../../../engine/weapon/WeaponIdResolver");
  registerWeaponIdResolver(fpsModule.canonicalWeaponId);
  await fpsModule.registerFpsCommands();
  const { registerNetworkConnector } = await import("../../../engine/ui/components/NetworkConnector");
  registerNetworkConnector(fpsModule.fpsNetworkConnector);
  const { registerGameplayMapLauncher } = await import("../../../engine/console/GameplayMapLauncher");
  registerGameplayMapLauncher(fpsModule.fpsMapLauncher);
}
