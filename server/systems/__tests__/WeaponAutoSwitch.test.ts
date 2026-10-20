import { describe, expect, it } from "vitest";
import { WeaponSystem } from "../WeaponSystem";

/**
 * Walking over a gun while holding the blade is an unambiguous request for a
 * gun. Every path through `addWeapon` has to honour it, because from the
 * player's side they all look identical — you touched a weapon and you are
 * still holding a knife.
 */
const ENTITY = 1 as never;

function loadout(weapons: string[]) {
  return {
    weapons,
    ammo: { blade: 1, machinegun: 160, riotgun: 32, rlauncher: 20 },
    health: 100,
    armor: 0,
  } as never;
}

function currentWeapon(sys: WeaponSystem): string | undefined {
  return sys.getWeaponState(ENTITY)?.currentWeapon;
}

describe("picking up a gun while holding the blade", () => {
  it("switches when the weapon is new", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(ENTITY, loadout(["blade"]));
    expect(currentWeapon(sys)).toBe("blade");

    sys.addWeapon(ENTITY, "machinegun");

    expect(currentWeapon(sys)).toBe("machinegun");
  });

  it("switches when the weapon is already owned", () => {
    // Spawning with a loadout puts the blade in your hands and the guns in
    // your pack. Running over one of those guns must arm you with it.
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(ENTITY, loadout(["blade", "machinegun"]));
    expect(currentWeapon(sys)).toBe("blade");

    const result = sys.addWeapon(ENTITY, "machinegun");

    expect(result.added).toBe(false); // already owned — ammo only
    expect(currentWeapon(sys)).toBe("machinegun");
  });

  it("arms you from your own pack when the pickup is declined at capacity", () => {
    // Two guns carried plus the permanent blade is full. The blade cannot be
    // dropped, so the new gun is declined — but standing there holding a knife
    // with two guns on your back is not an acceptable outcome.
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(ENTITY, loadout(["blade", "machinegun", "riotgun"]));
    expect(currentWeapon(sys)).toBe("blade");

    const result = sys.addWeapon(ENTITY, "rlauncher");

    expect(result.added).toBe(false);
    expect(currentWeapon(sys)).toBe("machinegun");
  });

  it("leaves a real weapon alone", () => {
    // Only the blade means "unarmed". Someone holding a rocket launcher who
    // runs over a machinegun has made no request at all, and yanking their
    // weapon away mid-fight would be its own bug.
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(ENTITY, loadout(["blade", "rlauncher"]));
    sys.addWeapon(ENTITY, "rlauncher");
    expect(currentWeapon(sys)).toBe("rlauncher");

    sys.addWeapon(ENTITY, "machinegun");

    expect(currentWeapon(sys)).toBe("machinegun"); // new weapon: the existing auto-switch
  });

  it("does not switch to the blade itself", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(ENTITY, loadout(["blade"]));

    sys.addWeapon(ENTITY, "blade");

    expect(currentWeapon(sys)).toBe("blade");
  });
});

describe("with auto-switch turned off (cl_autoswitch 0)", () => {
  function noSwitch(weapons: string[]): WeaponSystem {
    const sys = new WeaponSystem();
    sys.setAutoSwitchPreference(() => false);
    sys.initializeWeaponFromLoadout(ENTITY, loadout(weapons));
    return sys;
  }

  it("keeps the blade out over a new gun, an owned one, and one declined at capacity", () => {
    const fresh = noSwitch(["blade"]);
    expect(fresh.addWeapon(ENTITY, "machinegun").added).toBe(true);
    expect(currentWeapon(fresh)).toBe("blade");
    expect(fresh.getWeaponState(ENTITY)?.weapons).toContain("machinegun");

    const owned = noSwitch(["blade", "machinegun"]);
    owned.addWeapon(ENTITY, "machinegun");
    expect(currentWeapon(owned)).toBe("blade");

    const full = noSwitch(["blade", "machinegun", "riotgun"]);
    full.addWeapon(ENTITY, "rlauncher");
    expect(currentWeapon(full)).toBe("blade");
  });
});
