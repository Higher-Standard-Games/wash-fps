// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The viewmodel the spectated weapon is loaded into.
 *
 * Mocked at the module boundary because the real one wants a Babylon scene, a
 * camera and a PK3 index; what this test is about is which calls are made, not
 * what they render.
 */
const wvm = {
  isReady: true,
  displayed: "gunblade" as string | null,
  switching: false,
  getDisplayedWeaponId: vi.fn(() => wvm.displayed),
  isSwitching: vi.fn(() => wvm.switching),
  loadWeapon: vi.fn(async () => true),
  setVisible: vi.fn(),
};

vi.mock("../../../../engine/weapon/WeaponViewManager", () => ({
  getWeaponViewManager: () => wvm,
}));

/**
 * The local weapon path. Nothing here may run for a spectated player: these
 * calls describe the gun WE are holding, and the server would fight us over
 * every one of them.
 */
const inventory = { syncFromServer: vi.fn() };
vi.mock("../../FPSPlayer", () => ({
  FPSPlayer: {
    getInstance: () => ({
      inventory,
      setServerReloadState: vi.fn(),
      syncFireTiming: vi.fn(),
      getController: () => ({ currentWeaponSlot: 0 }),
    }),
  },
}));

const { handleSpectatedWeaponState } = await import("../GameEvents");
const { HUDState } = await import("../HUDState");

function weaponState(currentWeapon: string, clip = 12, reserve = 40) {
  return {
    currentWeapon,
    weapons: [currentWeapon, "gunblade"],
    ammo: { [currentWeapon]: { clip, reserve } },
  };
}

describe("spectated weapon state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wvm.isReady = true;
    wvm.displayed = "gunblade";
    wvm.switching = false;
  });

  it("puts the watched player's weapon and ammo on the HUD", () => {
    handleSpectatedWeaponState(weaponState("rocketlauncher", 4, 20));

    const hud = HUDState.getInstance();
    expect(hud.currentWeapon).toBe("rocketlauncher");
    expect(hud.getAmmoDisplay("rocketlauncher")).toBe("4 / 20");
  });

  it("never touches local inventory or prediction", () => {
    handleSpectatedWeaponState(weaponState("rocketlauncher"));

    // The whole reason this is a separate function from the local sync.
    expect(inventory.syncFromServer).not.toHaveBeenCalled();
  });

  it("puts their gun in our hands", () => {
    handleSpectatedWeaponState(weaponState("rocketlauncher"));

    expect(wvm.loadWeapon).toHaveBeenCalledWith("rocketlauncher");
    expect(wvm.setVisible).toHaveBeenCalledWith(true);
  });

  it("does not reload a weapon already on screen", () => {
    wvm.displayed = "rocketlauncher";

    handleSpectatedWeaponState(weaponState("rocketlauncher"));

    // Level-triggered, not edge-triggered: this runs on EVERY snapshot, so
    // reloading each time would restart the model load sixty times a second.
    expect(wvm.loadWeapon).not.toHaveBeenCalled();
    // Visibility is still asserted every frame — it is the one thing that can
    // be turned off underneath us, by our own death.
    expect(wvm.setVisible).toHaveBeenCalledWith(true);
  });

  it("leaves an in-flight switch alone", () => {
    wvm.switching = true;

    handleSpectatedWeaponState(weaponState("rocketlauncher"));

    expect(wvm.loadWeapon).not.toHaveBeenCalled();
  });

  it("waits for the viewmodel to be ready before driving it", () => {
    wvm.isReady = false;

    handleSpectatedWeaponState(weaponState("rocketlauncher"));

    expect(wvm.loadWeapon).not.toHaveBeenCalled();
    expect(wvm.setVisible).not.toHaveBeenCalled();
  });

  it("survives a weapon model that will not load", async () => {
    wvm.loadWeapon.mockRejectedValueOnce(new Error("no such pk3"));

    expect(() => handleSpectatedWeaponState(weaponState("rocketlauncher"))).not.toThrow();
    // An unhandled rejection here would surface as a spectator-only crash.
    await Promise.resolve();
  });

  it("tolerates a snapshot with no weapon list", () => {
    expect(() =>
      handleSpectatedWeaponState({ currentWeapon: "rocketlauncher" } as unknown as ReturnType<typeof weaponState>),
    ).not.toThrow();
  });
});
