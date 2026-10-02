// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The viewmodel the spectated weapon is loaded into.
 *
 * A stand-in because the real one wants a Babylon scene, a camera and a PK3
 * index; what this test is about is which calls are made, not what they render.
 */
const wvm = {
  isReady: true,
  displayed: "gunblade" as string | null,
  getDisplayedWeaponId: vi.fn(() => wvm.displayed),
  loadWeapon: vi.fn(async (id: string) => {
    wvm.displayed = id;
    return true;
  }),
  switchWeaponAnimated: vi.fn(async (id: string) => {
    wvm.displayed = id;
  }),
  cancelSwitch: vi.fn(),
  clearFollowedBob: vi.fn(),
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
const { FollowedViewWeapon } = await import("../FollowedViewWeapon");
type WeaponView = import("../../../../engine/weapon/WeaponViewManager").WeaponViewManager;

function weaponState(currentWeapon: string, clip = 12, reserve = 40) {
  return {
    currentWeapon,
    weapons: [currentWeapon, "gunblade"],
    ammo: { [currentWeapon]: { clip, reserve } },
  };
}

describe("spectated weapon state", () => {
  let followed: InstanceType<typeof FollowedViewWeapon>;

  beforeEach(() => {
    vi.clearAllMocks();
    wvm.isReady = true;
    wvm.displayed = "gunblade";
    followed = new FollowedViewWeapon(() => wvm as unknown as WeaponView);
    followed.follow("player_2");
  });

  it("puts the watched player's weapon and ammo on the HUD", () => {
    handleSpectatedWeaponState(weaponState("rocketlauncher", 4, 20), followed);

    const hud = HUDState.getInstance();
    expect(hud.currentWeapon).toBe("rocketlauncher");
    expect(hud.getAmmoDisplay("rocketlauncher")).toBe("4 / 20");
  });

  it("never touches local inventory or prediction", () => {
    handleSpectatedWeaponState(weaponState("rocketlauncher"), followed);

    // The whole reason this is a separate function from the local sync.
    expect(inventory.syncFromServer).not.toHaveBeenCalled();
  });

  it("puts their gun in our hands at once when we start watching", () => {
    handleSpectatedWeaponState(weaponState("rocketlauncher"), followed);

    // A cut, not a switch: they were already holding it.
    expect(wvm.loadWeapon).toHaveBeenCalledWith("rocketlauncher");
    expect(wvm.switchWeaponAnimated).not.toHaveBeenCalled();
    expect(wvm.setVisible).toHaveBeenCalledWith(true);
  });

  it("plays their later weapon changes as switches", () => {
    handleSpectatedWeaponState(weaponState("rocketlauncher"), followed);
    vi.clearAllMocks();

    handleSpectatedWeaponState(weaponState("plasmagun"), followed);

    expect(wvm.switchWeaponAnimated).toHaveBeenCalledWith("plasmagun");
    expect(wvm.loadWeapon).not.toHaveBeenCalled();
  });

  it("does not reload a weapon already on screen", () => {
    wvm.displayed = "rocketlauncher";

    handleSpectatedWeaponState(weaponState("rocketlauncher"), followed);

    // Compared against the view, not the last request: this runs on EVERY
    // snapshot, so reloading each time would restart the model load sixty
    // times a second.
    expect(wvm.loadWeapon).not.toHaveBeenCalled();
    expect(wvm.switchWeaponAnimated).not.toHaveBeenCalled();
    // Visibility is still asserted every snapshot — it is the one thing that
    // can be turned off underneath us, by our own death.
    expect(wvm.setVisible).toHaveBeenCalledWith(true);
  });

  it("waits for the viewmodel to be ready before driving it", () => {
    wvm.isReady = false;
    wvm.setVisible.mockClear();

    handleSpectatedWeaponState(weaponState("rocketlauncher"), followed);

    expect(wvm.loadWeapon).not.toHaveBeenCalled();
    expect(wvm.setVisible).not.toHaveBeenCalled();
  });

  it("survives a weapon model that will not load", async () => {
    wvm.loadWeapon.mockRejectedValueOnce(new Error("no such pk3"));

    expect(() => handleSpectatedWeaponState(weaponState("rocketlauncher"), followed)).not.toThrow();
    // An unhandled rejection here would surface as a spectator-only crash.
    await Promise.resolve();
  });

  it("tolerates a snapshot with no weapon list", () => {
    expect(() =>
      handleSpectatedWeaponState(
        { currentWeapon: "rocketlauncher" } as unknown as ReturnType<typeof weaponState>,
        followed,
      ),
    ).not.toThrow();
  });
});
