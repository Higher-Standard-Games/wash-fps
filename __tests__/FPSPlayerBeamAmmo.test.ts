import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FPSController } from "../../../engine/camera/controllers/FPSController";
import type { WeaponDef } from "../../../shared/entities";

const weaponView = vi.hoisted(() => ({
  isSwitching: vi.fn(() => false),
  setBeamActive: vi.fn(),
  setBeamCharging: vi.fn(),
  setPowerupOutlineOverride: vi.fn(),
  startReload: vi.fn(),
  cancelReload: vi.fn(),
  switchWeaponAnimated: vi.fn(),
}));

vi.mock("../../../engine/weapon/WeaponViewManager", () => {
  function WeaponViewManager(): void {}
  WeaponViewManager.getInstance = () => weaponView;
  return { WeaponViewManager };
});

import { HUDState } from "../client/HUDState";
import { clearLocalPowerups, setLocalPowerup } from "../client/LocalPowerupState";
import { FPSPlayer } from "../FPSPlayer";

const BEAM_WEAPON = {
  id: "voltaic",
  hitscanType: "beam",
  fireRate: 20,
  fireMode: "auto",
  reloadModel: "clip",
  clipSize: 60,
  reloadTime: 1.5,
  ammoType: "cells",
  muzzleFlash: { color: { r: 1, g: 0.2, b: 0.05 } },
} as unknown as WeaponDef;

function makeController(): FPSController {
  return {
    isEnabled: () => true,
    isFiring: () => true,
    isAiming: () => true,
    setInventory: vi.fn(),
    setWeaponSwitchBlockedCheck: vi.fn(),
    onWeaponSelect: null,
    onReload: null,
    onUse: null,
  } as unknown as FPSController;
}

describe("FPSPlayer beam ammo presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalPowerups();
    weaponView.isSwitching.mockReturnValue(false);
  });

  it("drives the first-person Quad outline from authoritative local powerup state", () => {
    const player = new FPSPlayer(makeController());
    setLocalPowerup("quad", 10);

    player.update(1 / 60);
    expect(weaponView.setPowerupOutlineOverride).toHaveBeenLastCalledWith(true, expect.anything(), expect.any(Number));

    clearLocalPowerups();
    player.update(1 / 60);
    expect(weaponView.setPowerupOutlineOverride).toHaveBeenLastCalledWith(false, expect.anything(), expect.any(Number));
    player.dispose();
  });

  it("shuts every local beam layer off when the authoritative clip reaches zero", () => {
    const player = new FPSPlayer(makeController());
    let loadedAmmo = 1;

    vi.spyOn(player.inventory, "getCurrentWeapon").mockReturnValue(BEAM_WEAPON);
    vi.spyOn(player.inventory, "getCurrentWeaponId").mockReturnValue("voltaic");
    vi.spyOn(player.inventory, "getLoadedAmmo").mockImplementation(() => loadedAmmo);

    player.update(1 / 60);
    expect(weaponView.setBeamActive).toHaveBeenLastCalledWith(true, expect.anything());

    weaponView.setBeamActive.mockClear();
    weaponView.setBeamCharging.mockClear();
    loadedAmmo = 0;
    player.update(1 / 60);

    expect(weaponView.setBeamActive).toHaveBeenCalledWith(false);
    expect(weaponView.setBeamActive).not.toHaveBeenCalledWith(true, expect.anything());
    expect(weaponView.setBeamCharging).toHaveBeenCalledWith(0);
    player.dispose();
  });

  it("turns the beam off on death with fire still held, and keeps it off", () => {
    const player = new FPSPlayer(makeController());
    vi.spyOn(player.inventory, "getCurrentWeapon").mockReturnValue(BEAM_WEAPON);
    vi.spyOn(player.inventory, "getCurrentWeaponId").mockReturnValue("voltaic");
    vi.spyOn(player.inventory, "getLoadedAmmo").mockReturnValue(60);

    player.update(1 / 60);
    expect(weaponView.setBeamActive).toHaveBeenLastCalledWith(true, expect.anything());

    // The death event turns it off once; the held fire turned it straight back on (L2).
    HUDState.getInstance().localDead = true;
    try {
      player.update(1 / 60);
      player.update(1 / 60);
      expect(weaponView.setBeamActive).toHaveBeenLastCalledWith(false);
    } finally {
      HUDState.getInstance().localDead = false;
      player.dispose();
    }
  });
});
