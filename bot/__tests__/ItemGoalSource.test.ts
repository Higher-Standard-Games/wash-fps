import { describe, expect, it } from "vitest";
import type { PickupEntry } from "../../shared/bsp/PickupTable";
import { BotGameState } from "../BotGameState";
import { collectItemGoals, MAX_ITEM_CANDIDATES } from "../goals/ItemGoalSource";

function entry(id: number, classname: string, type: PickupEntry["type"], kind: string, x: number): PickupEntry {
  return { id, classname, type, kind, position: { x, y: 0, z: 0 } };
}

function stateAtOrigin(activeMask: boolean[] = []): BotGameState {
  const state = new BotGameState();
  state.self.position = { x: 0, y: 0, z: 0 };
  state.pickupActiveMask = activeMask;
  state.pickups = [];
  return state;
}

describe("collectItemGoals", () => {
  // Twenty shells within reach, a Red Armor across the map.
  const shells = Array.from({ length: 20 }, (_, i) => entry(i, "ammo_riotgun", "ammo", "shells", 100 + i * 10));
  const redArmor = entry(20, "item_armor_ra", "armor", "ra", 2500);

  it("keeps the nearest few ordinary items", () => {
    const goals = collectItemGoals(stateAtOrigin(), { pickupPositions: shells, maxDistance: 1500 });
    expect(goals).toHaveLength(MAX_ITEM_CANDIDATES);
    expect(goals.every((g) => g.pickupId !== undefined && g.pickupId < MAX_ITEM_CANDIDATES)).toBe(true);
  });

  it("always offers a major item that is up, however far and however many are nearer", () => {
    const goals = collectItemGoals(stateAtOrigin(), { pickupPositions: [...shells, redArmor], maxDistance: 1500 });
    expect(goals.some((g) => g.pickupId === 20)).toBe(true);
    expect(goals).toHaveLength(MAX_ITEM_CANDIDATES + 1);
  });

  it("does not offer a major item that has been taken", () => {
    const mask = Array.from({ length: 21 }, (_, i) => i !== 20);
    const goals = collectItemGoals(stateAtOrigin(mask), { pickupPositions: [...shells, redArmor], maxDistance: 1500 });
    expect(goals.some((g) => g.pickupId === 20)).toBe(false);
  });
});

describe("item timing", () => {
  const redArmor = entry(0, "item_armor_ra", "armor", "ra", 400);
  const shells = entry(1, "ammo_riotgun", "ammo", "shells", 300);

  /** A state that saw the Red Armor (and the shells) taken at tick 1000, now at `tick`. */
  function takenAt1000(tick: number): BotGameState {
    const state = stateAtOrigin();
    state.pickupActiveMask = [false, false];
    state.itemTakenTick.set(0, 1000);
    state.itemTakenTick.set(1, 1000);
    state.tick = tick;
    return state;
  }

  it("offers a taken major item with the tick it returns, when timing", () => {
    const goals = collectItemGoals(takenAt1000(2000), {
      pickupPositions: [redArmor, shells],
      maxDistance: 1500,
      timing: true,
    });
    expect(goals).toHaveLength(1);
    expect(goals[0].pickupId).toBe(0);
    expect(goals[0].respawnTick).toBe(1000 + 25 * 125);
  });

  it("offers nothing that is down when not timing", () => {
    const goals = collectItemGoals(takenAt1000(2000), { pickupPositions: [redArmor, shells], maxDistance: 1500 });
    expect(goals).toHaveLength(0);
  });

  it("does not offer an item whose return is unknown", () => {
    const state = takenAt1000(2000);
    state.itemTakenTick.clear();
    expect(collectItemGoals(state, { pickupPositions: [redArmor], maxDistance: 1500, timing: true })).toHaveLength(0);
  });

  it("times the first armor spawn from the match going live", () => {
    const state = stateAtOrigin([false]);
    state.liveSinceTick = 500;
    state.tick = 600;
    const goals = collectItemGoals(state, { pickupPositions: [redArmor], maxDistance: 1500, timing: true });
    expect(goals[0]?.respawnTick).toBe(500 + 15 * 125);
  });
});
