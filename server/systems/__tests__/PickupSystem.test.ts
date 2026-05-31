/**
 * PickupSystem integration tests — server-authoritative armor/health grants,
 * per-type respawn, the armor first-spawn delay, and the active-set mask.
 *
 * Uses a minimal WorldState/player stub (the only surface PickupSystem.update
 * touches: entitiesByType + the player's transform/input/health).
 */

import { beforeEach, describe, expect, it } from "vitest";
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

describe("PickupSystem — armor", () => {
  let sys: PickupSystem;
  let player: ReturnType<typeof makePlayer>;

  beforeEach(() => {
    sys = new PickupSystem();
    player = makePlayer();
  });

  it("is inactive (not spawned) during the 15s first-spawn delay", () => {
    sys.setPickupItems([armorEntry("ra")]);
    sys.update(makeState(player) as never, 0.008, 100 as never); // ~0.8s
    expect(sys.getActiveMask()[0]).toBe(false);
    expect(player.health.armor).toBe(0); // not granted while delayed
  });

  it("activates after the 15s delay and grants on proximity (ra → 100)", () => {
    sys.setPickupItems([armorEntry("ra")]);
    // Past the delay but player out of range → active, not granted.
    const far = makePlayer(9999, 0, 0);
    sys.update(makeState(far) as never, 0.008, (16 * TICK_RATE) as never);
    expect(sys.getActiveMask()[0]).toBe(true);
    expect(far.health.armor).toBe(0);

    // Player on the armor → granted, then consumed (mask false).
    sys.update(makeState(player) as never, 0.008, (16 * TICK_RATE + 1) as never);
    expect(player.health.armor).toBe(100);
    expect(sys.getActiveMask()[0]).toBe(false);
  });

  it("green armor inserts one plate from a partial (58 → 75)", () => {
    sys.setPickupItems([armorEntry("ga")]);
    player.health.armor = 58;
    sys.update(makeState(player) as never, 0.008, (16 * TICK_RATE) as never);
    expect(player.health.armor).toBe(75);
  });

  it("does not consume armor that gives no benefit (already full)", () => {
    sys.setPickupItems([armorEntry("ra")]);
    player.health.armor = 100;
    sys.update(makeState(player) as never, 0.008, (16 * TICK_RATE) as never);
    expect(sys.getActiveMask()[0]).toBe(true); // left for later
  });
});

describe("PickupSystem — health", () => {
  let sys: PickupSystem;

  beforeEach(() => {
    sys = new PickupSystem();
  });

  it("small health grants immediately (no first-spawn delay)", () => {
    sys.setPickupItems([healthEntry("small")]);
    const player = makePlayer();
    player.health.health = 50;
    sys.update(makeState(player) as never, 0.008, 10 as never);
    expect(player.health.health).toBe(75);
    expect(sys.getActiveMask()[0]).toBe(false); // consumed
  });

  it("mega health has the 15s first-spawn delay (like armor)", () => {
    sys.setPickupItems([healthEntry("mega")]);
    const player = makePlayer();
    sys.update(makeState(player) as never, 0.008, 100 as never); // ~0.8s
    expect(sys.getActiveMask()[0]).toBe(false);
    expect(player.health.health).toBe(100); // not granted while delayed
  });

  it("mega health overheals to 200 then decays 1 HP/s toward 100", () => {
    sys.setPickupItems([healthEntry("mega")]);
    const player = makePlayer();
    // Grant after the first-spawn delay.
    sys.update(makeState(player) as never, 0.008, (16 * TICK_RATE) as never);
    expect(player.health.health).toBe(200);

    // One second later, the decay tick bleeds 1 HP.
    sys.update(makeState(player) as never, 0.008, (17 * TICK_RATE) as never);
    expect(player.health.health).toBe(199);
  });
});
