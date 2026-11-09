import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeaponDef } from "../../../shared/entities";
import type { FPSController } from "../camera/FPSController";

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
import { MatchPhase, MatchStateManager } from "../client/MatchStateManager";
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

function makeController(aiming = true): FPSController {
  return {
    isEnabled: () => true,
    isFiring: () => true,
    isAiming: () => aiming,
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
    MatchStateManager.destroy();
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
    loadedAmmo = 0;
    player.update(1 / 60);

    expect(weaponView.setBeamActive).toHaveBeenCalledWith(false);
    expect(weaponView.setBeamActive).not.toHaveBeenCalledWith(true, expect.anything());
    player.dispose();
  });

  it("draws the beam from the first frame when fired from the hip", () => {
    const player = new FPSPlayer(makeController(false));
    vi.spyOn(player.inventory, "getCurrentWeapon").mockReturnValue(BEAM_WEAPON);
    vi.spyOn(player.inventory, "getCurrentWeaponId").mockReturnValue("voltaic");
    vi.spyOn(player.inventory, "getLoadedAmmo").mockReturnValue(10);

    player.update(1 / 60);

    expect(weaponView.setBeamActive).toHaveBeenLastCalledWith(true, expect.anything());
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
  it("clears a held warmup beam during countdown and stays clear after respawning with Blade", () => {
    const player = new FPSPlayer(makeController());
    let weapon = BEAM_WEAPON;
    vi.spyOn(player.inventory, "getCurrentWeapon").mockImplementation(() => weapon);
    vi.spyOn(player.inventory, "getCurrentWeaponId").mockImplementation(() => weapon.id);
    vi.spyOn(player.inventory, "getLoadedAmmo").mockReturnValue(60);
    const match = MatchStateManager.getInstance();
    match.processEvent({ type: "match_state", phase: MatchPhase.Warmup, round: 0 });
    player.update(1 / 60);
    expect(weaponView.setBeamActive).toHaveBeenLastCalledWith(true, expect.anything());
    match.processEvent({ type: "match_state", phase: MatchPhase.Countdown, round: 1 });
    player.update(1 / 60);
    expect(weaponView.setBeamActive).toHaveBeenLastCalledWith(false);
    weaponView.setBeamActive.mockClear();
    weapon = { id: "blade" } as WeaponDef;
    match.processEvent({ type: "match_state", phase: MatchPhase.Active, round: 1 });
    player.update(1 / 60);
    expect(weaponView.setBeamActive).not.toHaveBeenCalledWith(true, expect.anything());
    player.dispose();
    MatchStateManager.destroy();
  });

  it.each(["disabled controls", "non-beam weapon", "missing weapon", "weapon switch"])(
    "clears the beam on %s",
    (reason) => {
      const controller = makeController();
      const player = new FPSPlayer(controller);
      const current = vi.spyOn(player.inventory, "getCurrentWeapon").mockReturnValue(BEAM_WEAPON);
      vi.spyOn(player.inventory, "getCurrentWeaponId").mockReturnValue("voltaic");
      vi.spyOn(player.inventory, "getLoadedAmmo").mockReturnValue(60);
      player.update(1 / 60);
      weaponView.setBeamActive.mockClear();
      if (reason === "disabled controls") vi.spyOn(controller, "isEnabled").mockReturnValue(false);
      else if (reason === "weapon switch") weaponView.isSwitching.mockReturnValue(true);
      else current.mockReturnValue(reason === "missing weapon" ? undefined : ({ id: "blade" } as WeaponDef));
      player.update(1 / 60);
      expect(weaponView.setBeamActive).toHaveBeenCalledWith(false);
      player.dispose();
    },
  );

  it("allows held fire during a continuous mode's non-frozen pre-match countdown", () => {
    const player = new FPSPlayer(makeController());
    vi.spyOn(player.inventory, "getCurrentWeapon").mockReturnValue(BEAM_WEAPON);
    vi.spyOn(player.inventory, "getCurrentWeaponId").mockReturnValue("voltaic");
    vi.spyOn(player.inventory, "getLoadedAmmo").mockReturnValue(60);
    MatchStateManager.getInstance().processEvent({ type: "match_state", phase: MatchPhase.Countdown, round: 0 });
    player.update(1 / 60);
    expect(weaponView.setBeamActive).toHaveBeenLastCalledWith(true, expect.anything());
    player.dispose();
    MatchStateManager.destroy();
  });
});
