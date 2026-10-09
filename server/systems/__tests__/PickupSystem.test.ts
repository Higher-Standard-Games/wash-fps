/**
 * PickupSystem integration tests - server-authoritative item grants and masks.
 */

import { EntityType } from "@engine/server/ecs/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("restarts delayed-item timing relative to the live match tick", () => {
    sys.setPickupItems([armorEntry("ra")]);
    const matchStartTick = 10_000;
    sys.resetForMatch(matchStartTick);
    const far = makePlayer(9999, 0, 0);

    sys.update(makeState(far) as never, 0.008, (matchStartTick + 15 * TICK_RATE - 1) as never);
    expect(sys.getActiveMask()[0]).toBe(false);

    sys.update(makeState(far) as never, 0.008, (matchStartTick + 15 * TICK_RATE) as never);
    expect(sys.getActiveMask()[0]).toBe(true);
  });
});

describe("PickupSystem - health", () => {
  let sys: PickupSystem;

  beforeEach(() => {
    sys = new PickupSystem();
  });

  it("small bubble grants +5 immediately", () => {
    sys.setPickupItems([healthEntry("small")]);
    const player = makePlayer();
    player.health.health = 50;
    sys.update(makeState(player) as never, 0.008, 10 as never);
    expect(player.health.health).toBe(55);
    expect(sys.getActiveMask()[0]).toBe(false);
  });

  it("medium health grants +25 immediately", () => {
    sys.setPickupItems([healthEntry("medium")]);
    const player = makePlayer();
    player.health.health = 50;
    sys.update(makeState(player) as never, 0.008, 10 as never);
    expect(player.health.health).toBe(75);
    expect(sys.getActiveMask()[0]).toBe(false);
  });

  it("small health is left on the map at full HP (stays visible, not consumed)", () => {
    sys.setPickupItems([healthEntry("small")]);
    const player = makePlayer(); // starts at 100
    sys.update(makeState(player) as never, 0.008, 10 as never);
    expect(player.health.health).toBe(100); // no benefit → not taken
    expect(sys.getActiveMask()[0]).toBe(true); // still active/visible
  });

  it("small health grants +5 when the player is hurt", () => {
    sys.setPickupItems([healthEntry("small")]);
    const player = makePlayer();
    player.health.health = 90;
    sys.update(makeState(player) as never, 0.008, 10 as never);
    expect(player.health.health).toBe(95);
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

// ── Round-scoped items ───────────────────────────────────────────────

describe("PickupSystem - round respawn modes", () => {
  /** Take the item at tick `t`, then report whether it is back at `t + later`. */
  function takeThenCheck(sys: PickupSystem, t: number, later: number): boolean {
    // Hurt: a health pickup is refused at full health, and would look like a
    // respawn-mode bug rather than the pickup rule it is.
    const grabber = makePlayer();
    grabber.health.health = 40;
    sys.update(makeState(grabber) as never, 0.008, t as never);
    expect(sys.getActiveMask()[0]).toBe(false);

    const bystander = makePlayer(9999, 0, 0);
    sys.update(makeState(bystander) as never, 0.008, (t + later) as never);
    return sys.getActiveMask()[0];
  }

  it("respawns on its own timer in the default mode", () => {
    const sys = new PickupSystem();
    sys.setPickupItems([healthEntry("small")]);
    expect(takeThenCheck(sys, 100, 21 * TICK_RATE)).toBe(true);
  });

  it("stays gone for the rest of the round in round mode", () => {
    // There is one of each per round, so taking it is a decision rather than a
    // timing exercise — the round is shorter than most respawn timers anyway.
    const sys = new PickupSystem();
    sys.setRespawnMode("round");
    sys.setPickupItems([healthEntry("small")]);
    expect(takeThenCheck(sys, 100, 60 * TICK_RATE)).toBe(false);
  });

  it("comes back at the next round", () => {
    const sys = new PickupSystem();
    sys.setRespawnMode("round");
    sys.setPickupItems([healthEntry("small")]);
    takeThenCheck(sys, 100, 1);

    sys.resetForRound(10_000);
    expect(sys.getActiveMask()[0]).toBe(true);
  });

  it("makes an item taken this round sit out the next one, when alternating", () => {
    // The denial play: taking the item reaches into the following round.
    const sys = new PickupSystem();
    sys.setRespawnMode("alternating");
    sys.setPickupItems([healthEntry("small")]);
    takeThenCheck(sys, 100, 1);

    sys.resetForRound(10_000);
    expect(sys.getActiveMask()[0]).toBe(false);

    // ...and returns the round after, having gone untouched.
    sys.resetForRound(20_000);
    expect(sys.getActiveMask()[0]).toBe(true);
  });

  it("does not hold an item back that nobody took", () => {
    const sys = new PickupSystem();
    sys.setRespawnMode("alternating");
    sys.setPickupItems([healthEntry("small")]);
    sys.resetForRound(10_000);
    expect(sys.getActiveMask()[0]).toBe(true);
  });
});

describe("PickupSystem - items the mode leaves out", () => {
  it("keeps them registered and inactive, so the client's mask hides them, past its end too", () => {
    const sys = new PickupSystem();
    const weapon: PickupEntry = {
      id: 2,
      classname: "weapon_rocketlauncher",
      type: "weapon",
      kind: "rlauncher",
      position: { x: 0, y: 0, z: 0 },
    };
    sys.setPickupItems(
      [ammoEntry("rockets", 5, 0), healthEntry("small", 1), weapon],
      new Set(["weapon_rocketlauncher"]),
    );

    const player = makePlayer();
    for (const tick of [100, 60 * TICK_RATE]) {
      sys.update(makeState(player) as never, 0.008, tick as never);
      const mask = sys.getActiveMask();
      // The highest id: dropped from the list, it lay past the mask's end and was never hidden
      expect(mask).toHaveLength(3);
      expect(mask[2]).toBe(false);
      expect(mask[0]).toBe(true);
    }
    sys.resetForRound(70 * TICK_RATE);
    expect(sys.getActiveMask()[2]).toBe(false);
  });
});
