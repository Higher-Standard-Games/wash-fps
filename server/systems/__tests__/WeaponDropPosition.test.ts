import { describe, expect, it } from "vitest";
import { WeaponSystem } from "../WeaponSystem";

/**
 * A dropped weapon lands where the player was. The position is handed in by the
 * caller (the kill event on death, the player's own transform on a swap) rather
 * than cached per tick, so these tests pin both entry points to the position they
 * were given.
 */
const ENTITY = 1 as never;

interface Drop {
  weaponId: string;
  ammo: number;
  position: { x: number; y: number; z: number };
}

function recorder() {
  const drops: Drop[] = [];
  return { drops, system: { queueDrop: (request: Drop) => drops.push(request) } as never };
}

function armed(weapons: string[]) {
  const sys = new WeaponSystem();
  const { drops, system } = recorder();
  sys.setDroppedWeaponSystem(system);
  sys.initializeWeaponFromLoadout(ENTITY, {
    weapons,
    ammo: { blade: 1, machinegun: 160, riotgun: 32, rlauncher: 20 },
    health: 100,
    armor: 0,
  } as never);
  return { sys, drops };
}

describe("dropping everything on death", () => {
  it("drops each carried weapon at the position it is given", () => {
    const { sys, drops } = armed(["blade", "machinegun", "rlauncher"]);

    sys.dropAllWeapons(ENTITY, { x: 100, y: 40, z: -30 });

    expect(drops.map((d) => d.weaponId).sort()).toEqual(["machinegun", "rlauncher"]);
    for (const drop of drops) expect(drop.position).toEqual({ x: 100, y: 60, z: -30 }); // 20 above the origin
  });

  it("never drops the blade", () => {
    const { sys, drops } = armed(["blade"]);
    sys.dropAllWeapons(ENTITY, { x: 0, y: 0, z: 0 });
    expect(drops).toHaveLength(0);
  });

  it("leaves the player holding the blade", () => {
    const { sys } = armed(["blade", "machinegun"]);
    sys.dropAllWeapons(ENTITY, { x: 0, y: 0, z: 0 });
    expect(sys.getWeaponState(ENTITY)?.currentWeapon).toBe("blade");
  });

  it("does not depend on any earlier position being cached", () => {
    // Nothing was ever recorded for this entity; the position argument is all there is.
    const { sys, drops } = armed(["blade", "riotgun"]);
    sys.dropAllWeapons(ENTITY, { x: 7, y: 8, z: 9 });
    expect(drops).toHaveLength(1);
    expect(drops[0].position).toEqual({ x: 7, y: 28, z: 9 });
  });
});

describe("swapping a weapon at capacity", () => {
  /** Two pickable weapons carried, rocket launcher in hand: the next pickup swaps it out. */
  function full() {
    const made = armed(["blade", "machinegun", "rlauncher"]);
    made.sys.getWeaponState(ENTITY)!.currentWeapon = "rlauncher";
    return made;
  }

  it("drops the swapped-out weapon where the player stands", () => {
    const { sys, drops } = full();

    const result = sys.addWeapon(ENTITY, "riotgun", { x: 5, y: 6, z: 7 });

    expect(result.added).toBe(true);
    expect(drops).toHaveLength(1);
    expect(drops[0].weaponId).toBe("rlauncher");
    expect(drops[0].position).toEqual({ x: 5, y: 26, z: 7 });
  });

  it("still completes the swap, without a drop, when no position is given", () => {
    const { sys, drops } = full();

    const result = sys.addWeapon(ENTITY, "riotgun");

    expect(result.added).toBe(true);
    expect(drops).toHaveLength(0);
    expect(sys.getWeaponState(ENTITY)?.weapons).toContain("riotgun");
  });
});
