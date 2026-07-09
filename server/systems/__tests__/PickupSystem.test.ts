/**
 * PickupSystem integration tests - server-authoritative item grants and masks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntityType } from "@engine/server/ecs/types";
import type { PickupEntry } from "../../../../../shared/bsp/PickupTable";
import { PickupSystem } from "../PickupSystem";

const TICK_RATE = 125;

function makePlayer(x = 0, y = 0, z = 0) {
  return {
    id: "p1",
    transform: { position: { x, y, z } },
    input: { buttons: 0 },
    health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
  };
}

function makeState(player: ReturnType<typeof makePlayer>) {
  return {
    entitiesByType: (t: EntityType) => (t === EntityType.Player ? [player] : []),
    removeEntity: () => {},
  };
}

const armorEntry = (kind: string, id = 0): PickupEntry => ({
  id,
  classname: `item_armor_${kind}`,
  type: "armor",
  kind,
  position: { x: 0, y: 0, z: 0 },
});

const healthEntry = (kind: string, id = 0): PickupEntry => ({
  id,
  classname: `item_health_${kind}`,
  type: "health",
  kind,
  position: { x: 0, y: 0, z: 0 },
});

const ammoEntry = (kind: string, amount = 10, id = 0): PickupEntry => ({
  id,
  classname: `ammo_${kind}`,
  type: "ammo",
  kind,
  amount,
  position: { x: 0, y: 0, z: 0 },
});

describe("PickupSystem - armor", () => {
  let sys: PickupSystem;
  let player: ReturnType<typeof makePlayer>;

  beforeEach(() => {
    sys = new PickupSystem();
    player = makePlayer();
  });

  it("is inactive during the 15s first-spawn delay", () => {
    sys.setPickupItems([armorEntry("ra")]);
    sys.update(makeState(player) as never, 0.008, 100 as never);
    expect(sys.getActiveMask()[0]).toBe(false);
    expect(player.health.armor).toBe(0);
  });

  it("activates after the 15s delay and grants on proximity", () => {
    sys.setPickupItems([armorEntry("ra")]);
    const far = makePlayer(9999, 0, 0);
    sys.update(makeState(far) as never, 0.008, (16 * TICK_RATE) as never);
    expect(sys.getActiveMask()[0]).toBe(true);
    expect(far.health.armor).toBe(0);

    sys.update(makeState(player) as never, 0.008, (16 * TICK_RATE + 1) as never);
    expect(player.health.armor).toBe(100);
    expect(sys.getActiveMask()[0]).toBe(false);
  });

  it("green armor inserts one plate from a partial", () => {
    sys.setPickupItems([armorEntry("ga")]);
    player.health.armor = 58;
    sys.update(makeState(player) as never, 0.008, (16 * TICK_RATE) as never);
    expect(player.health.armor).toBe(75);
  });

  it("does not consume armor that gives no benefit", () => {
    sys.setPickupItems([armorEntry("ra")]);
    player.health.armor = 100;
    sys.update(makeState(player) as never, 0.008, (16 * TICK_RATE) as never);
    expect(sys.getActiveMask()[0]).toBe(true);
  });
});

describe("PickupSystem - health", () => {
  let sys: PickupSystem;

  beforeEach(() => {
    sys = new PickupSystem();
  });

  it("small health grants immediately", () => {
    sys.setPickupItems([healthEntry("small")]);
    const player = makePlayer();
    player.health.health = 50;
    sys.update(makeState(player) as never, 0.008, 10 as never);
    expect(player.health.health).toBe(75);
    expect(sys.getActiveMask()[0]).toBe(false);
  });

  it("mega health has the 15s first-spawn delay", () => {
    sys.setPickupItems([healthEntry("mega")]);
    const player = makePlayer();
    sys.update(makeState(player) as never, 0.008, 100 as never);
    expect(sys.getActiveMask()[0]).toBe(false);
    expect(player.health.health).toBe(100);
  });

  it("mega health overheals to 200 then decays 1 HP/s toward 100", () => {
    sys.setPickupItems([healthEntry("mega")]);
    const player = makePlayer();
    sys.update(makeState(player) as never, 0.008, (16 * TICK_RATE) as never);
    expect(player.health.health).toBe(200);

    sys.update(makeState(player) as never, 0.008, (17 * TICK_RATE) as never);
    expect(player.health.health).toBe(199);
  });
});

describe("PickupSystem - ammo", () => {
  let sys: PickupSystem;
  let player: ReturnType<typeof makePlayer>;

  beforeEach(() => {
    sys = new PickupSystem();
    player = makePlayer();
  });

  it("auto-picks ammo through WeaponSystem and consumes the server pickup", () => {
    const addAmmoByType = vi.fn(() => true);
    sys.setWeaponSystem({ addAmmoByType } as never);
    sys.setPickupItems([ammoEntry("rockets", 10)]);

    sys.update(makeState(player) as never, 0.008, 10 as never);

    expect(addAmmoByType).toHaveBeenCalledWith("p1", "rockets", 10);
    expect(sys.getActiveMask()[0]).toBe(false);
    expect(sys.getPendingPickupEvents()[0]).toMatchObject({ pickupId: 0, weaponId: "rockets", entityId: "p1" });
  });

  it("leaves ammo active when the server grants nothing", () => {
    const addAmmoByType = vi.fn(() => false);
    sys.setWeaponSystem({ addAmmoByType } as never);
    sys.setPickupItems([ammoEntry("rockets", 10)]);

    sys.update(makeState(player) as never, 0.008, 10 as never);

    expect(addAmmoByType).toHaveBeenCalledWith("p1", "rockets", 10);
    expect(sys.getActiveMask()[0]).toBe(true);
    expect(sys.getPendingPickupEvents()).toHaveLength(0);
  });
});
