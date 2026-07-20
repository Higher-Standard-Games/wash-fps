/**
 * DroppedWeaponSystem lifetime regression.
 *
 * QA-WO12 flipped every subsystem's `CONFIG.tickRate` from 125 to 0 ("run every
 * base tick"). DroppedWeaponSystem still derived its timers from that field, so
 * `despawnTicks = DESPAWN_TIME * 0 = 0` and `dt = 1 / 0 = Infinity`: a dropped
 * weapon was removed the same tick it spawned (never serialized to clients) —
 * the "swap makes the old weapon just disappear" bug. These lock the fix.
 */
import { describe, expect, it } from "vitest";
import { DroppedWeaponSystem } from "../DroppedWeaponSystem";

interface StubEntity {
  id: number;
  transform?: { position: { x: number; y: number; z: number } };
}

function makeStubState() {
  const entities = new Map<number, StubEntity>();
  const state = {
    addEntity: (e: StubEntity) => entities.set(e.id, e),
    getEntity: (id: number) => entities.get(id),
    removeEntity: (id: number) => entities.delete(id),
    // biome-ignore lint/suspicious/noExplicitAny: minimal WorldState stub for this system
  } as any;
  return { state, entities };
}

describe("DroppedWeaponSystem lifetime (QA-WO12 regression)", () => {
  it("keeps a dropped weapon alive past the tick it spawned (despawnTicks must be > 0)", () => {
    const sys = new DroppedWeaponSystem();
    const { state, entities } = makeStubState();

    sys.queueDrop({
      weaponId: "rlauncher",
      ammo: 10,
      position: { x: 0, y: 100, z: 0 },
      velocity: { x: 10, y: 180, z: 0 },
    });

    // Spawn tick — the bug removed the entity in the same update() call.
    sys.update(state, 1 / 125, 1000 as never);
    expect(entities.size).toBe(1);

    const dropped = [...entities.values()][0];
    // dt = 1/0 = Infinity would have driven the position to NaN/Infinity.
    expect(Number.isFinite(dropped.transform?.position.y ?? Number.NaN)).toBe(true);
  });

  it("survives ~100 ticks (15s despawn window at the base rate, not 0)", () => {
    const sys = new DroppedWeaponSystem();
    const { state, entities } = makeStubState();

    sys.queueDrop({ weaponId: "plasmagun", ammo: 50, position: { x: 0, y: 64, z: 0 } });
    for (let tick = 1000; tick < 1100; tick++) sys.update(state, 1 / 125, tick as never);

    expect(entities.size).toBe(1);
  });
});
