/**
 * WeaponSystem — pulling the trigger on an empty gun.
 *
 * Firing dry used to fall through every branch and do nothing at all, which
 * reads as the game ignoring the input. Now the first pull reports it (the
 * client plays the empty click from its own ammo state) and a second pull — or
 * simply holding the trigger — trades the dead weapon for one that fires.
 *
 * The two-stage shape is deliberate: swapping on the first pull would tear a
 * player off their rocket launcher for one mistimed tap.
 */

import { describe, expect, it } from "vitest";
import { WeaponSystem } from "../WeaponSystem";

const ENTITY = 1 as never;
const FIRE_BUTTON = 1 << 8;
/** Must match WeaponSystem.DRY_FIRE_SWAP_TICKS. */
const SWAP_TICKS = 25;

/** Blade (infinite) plus an empty machinegun, with the machinegun in hand. */
function setup() {
  const sys = new WeaponSystem();
  sys.initializeWeaponFromLoadout(ENTITY, {
    weapons: ["blade", "machinegun"],
    ammo: { blade: 1, machinegun: 0 },
    health: 100,
    armor: 0,
  } as never);

  const shooter = {
    id: 1,
    ownerId: 1,
    transform: { position: { x: 0, y: 0, z: 0 } },
    input: { buttons: 0, yaw: 0, pitch: 0, weaponSlot: 0 },
    health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
  };
  const state = {
    entitiesByType: () => [shooter],
    getEntity: () => shooter,
    getEntityMut: () => shooter,
    addEntity: () => {},
    removeEntity: () => {},
  };

  // Take the machinegun out; slot 2 because the starter weapon holds slot 1.
  shooter.input.weaponSlot = 2;
  sys.update(state as never, 1 / 125, 50 as never);
  return { sys, shooter, state };
}

const weapon = (sys: WeaponSystem) => sys.getWeaponState(ENTITY)?.currentWeapon;

function pull(sys: WeaponSystem, shooter: { input: { buttons: number } }, state: unknown, tick: number) {
  shooter.input.buttons = FIRE_BUTTON;
  sys.update(state as never, 1 / 125, tick as never);
}

function release(sys: WeaponSystem, shooter: { input: { buttons: number } }, state: unknown, tick: number) {
  shooter.input.buttons = 0;
  sys.update(state as never, 1 / 125, tick as never);
}

describe("firing an empty weapon", () => {
  it("keeps the empty gun in hand on the first pull", () => {
    const { sys, shooter, state } = setup();
    expect(weapon(sys)).toBe("machinegun");

    pull(sys, shooter, state, 100);

    // Reported, not resolved — one mistimed tap must not cost you your weapon.
    expect(weapon(sys)).toBe("machinegun");
    expect(sys.getPendingDamage()).toHaveLength(0);
  });

  it("swaps on a second pull", () => {
    const { sys, shooter, state } = setup();
    pull(sys, shooter, state, 100);
    release(sys, shooter, state, 101);
    pull(sys, shooter, state, 102);

    expect(weapon(sys)).toBe("blade");
  });

  it("swaps on its own if the trigger is simply held", () => {
    const { sys, shooter, state } = setup();
    pull(sys, shooter, state, 100);
    expect(weapon(sys)).toBe("machinegun");

    // Still held, but not yet long enough to count as intent.
    for (let tick = 101; tick < 100 + SWAP_TICKS; tick++) pull(sys, shooter, state, tick);
    expect(weapon(sys)).toBe("machinegun");

    pull(sys, shooter, state, 100 + SWAP_TICKS);
    expect(weapon(sys)).toBe("blade");
  });

  it("leaves a brief tap alone", () => {
    const { sys, shooter, state } = setup();
    pull(sys, shooter, state, 100);
    for (let tick = 101; tick < 110; tick++) pull(sys, shooter, state, tick);
    release(sys, shooter, state, 110);

    expect(weapon(sys)).toBe("machinegun");
  });

  it("stays put when nothing else can fire either", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(ENTITY, {
      weapons: ["machinegun"],
      ammo: { machinegun: 0, blade: 0 },
      health: 100,
      armor: 0,
    } as never);
    const shooter = {
      id: 1,
      ownerId: 1,
      transform: { position: { x: 0, y: 0, z: 0 } },
      input: { buttons: 0, yaw: 0, pitch: 0, weaponSlot: 2 },
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
    const state = {
      entitiesByType: () => [shooter],
      getEntity: () => shooter,
      getEntityMut: () => shooter,
      addEntity: () => {},
      removeEntity: () => {},
    };
    sys.update(state as never, 1 / 125, 50 as never);
    const held = sys.getWeaponState(ENTITY)!.currentWeapon;

    shooter.input.buttons = FIRE_BUTTON;
    for (let tick = 100; tick < 100 + SWAP_TICKS * 3; tick++) sys.update(state as never, 1 / 125, tick as never);

    // Blade is `reloadModel: "none"`, so it is always a valid destination and the
    // machinegun swaps to it. What must not happen is a crash or an empty hand.
    expect(sys.getWeaponState(ENTITY)!.currentWeapon).toBeTruthy();
    expect(["blade", held]).toContain(sys.getWeaponState(ENTITY)!.currentWeapon);
  });

  it("forgets the dry pull once the weapon can fire again", () => {
    const { sys, shooter, state } = setup();
    pull(sys, shooter, state, 100);
    release(sys, shooter, state, 101);

    // Picking ammo up mid-pause must not leave a swap armed from earlier.
    sys.addAmmoByType(ENTITY, "bullets", 60);
    pull(sys, shooter, state, 102);

    expect(weapon(sys)).toBe("machinegun");
  });
});
