/**
 * Per-consideration contract tests.
 *
 * Considerations promise to be pure and to return a finite number in [0,1]
 * (Consideration.ts). Arbitration relies on both: the combination rule is
 * meaningless if a consideration can return 1.7, and the golden-scenario
 * fixtures are only reproducible if scoring never reads a clock or an RNG.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHT_PROFILE } from "../../shared/bot/WeightProfiles";
import type { PickupType } from "../../shared/bsp/PickupTable";
import { BotGameState } from "../BotGameState";
import type { BotGoal } from "../goals/BotGoal";
import type { ConsiderationContext } from "../goals/Consideration";
import { Danger } from "../goals/considerations/Danger";
import { ItemDenial } from "../goals/considerations/ItemDenial";
import { ItemValue } from "../goals/considerations/ItemValue";
import { estimateRouteCost, RouteCost } from "../goals/considerations/RouteCost";
import { ITEM_CONSIDERATIONS } from "../goals/ItemGoalPlanner";

const TYPES: PickupType[] = ["weapon", "ammo", "armor", "health", "powerup"];
const KINDS: Record<string, string[]> = {
  weapon: ["machinegun", "rlauncher", "instagun", "blade"],
  ammo: ["bullets", "rockets", "cells", "lasers", "shells"],
  armor: ["shard", "ga", "ya", "ra"],
  health: ["small", "medium", "large", "mega", "ultra"],
  powerup: ["quad"],
};

function makeContext(opts: {
  type: PickupType;
  kind: string;
  health: number;
  armor: number;
  routeCost: number | null;
  enemies: number;
  damageTicksAgo?: number;
}): ConsiderationContext {
  const state = new BotGameState();
  state.selfPlayerId = "bot";
  state.selfEntityId = "ent_bot";
  state.tick = 10_000;
  state.self.health = opts.health;
  state.self.armor = opts.armor;
  state.self.weapons = ["blade", "machinegun"];
  state.self.ammo = { machinegun: 30 };
  state.players = [];
  for (let i = 0; i < opts.enemies; i++) {
    state.players.push({
      entityId: `e${i}`,
      playerId: `p${i}`,
      position: { x: 900, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isDead: false,
      team: "",
      relation: "enemy",
      distance: 900,
    });
  }
  if (opts.damageTicksAgo !== undefined) {
    state.recentDamage = [
      {
        attackerId: "p0",
        damage: 30,
        tick: state.tick - opts.damageTicksAgo,
        weaponId: "machinegun",
        position: { x: 0, y: 0, z: 0 },
      },
    ];
  }

  const goal: BotGoal = {
    id: "item:pickup:1",
    kind: "acquire_item",
    position: { x: 100, y: 0, z: 0 },
    pickupId: 1,
    item: { type: opts.type, kind: opts.kind, amount: 10 },
  };

  return { goal, self: state.self, state, routeCost: opts.routeCost, weights: DEFAULT_WEIGHT_PROFILE };
}

describe("consideration contract", () => {
  it("every consideration returns a finite value in [0,1] across the input space", () => {
    for (const type of TYPES) {
      for (const kind of KINDS[type]) {
        for (const health of [0, 1, 37, 99, 100, 199]) {
          for (const armor of [0, 24, 58, 100]) {
            for (const routeCost of [null, 0, 250, 4000]) {
              for (const enemies of [0, 1, 5]) {
                const ctx = makeContext({ type, kind, health, armor, routeCost, enemies, damageTicksAgo: 10 });
                for (const consideration of ITEM_CONSIDERATIONS) {
                  const value = consideration.score(ctx);
                  expect(Number.isFinite(value), `${consideration.id} ${type}:${kind}`).toBe(true);
                  expect(value, `${consideration.id} ${type}:${kind}`).toBeGreaterThanOrEqual(0);
                  expect(value, `${consideration.id} ${type}:${kind}`).toBeLessThanOrEqual(1);
                }
              }
            }
          }
        }
      }
    }
  });

  it("is pure — identical contexts score identically", () => {
    const build = () =>
      makeContext({ type: "armor", kind: "ra", health: 50, armor: 20, routeCost: 700, enemies: 2, damageTicksAgo: 40 });
    for (const consideration of ITEM_CONSIDERATIONS) {
      expect(consideration.score(build())).toBe(consideration.score(build()));
    }
  });

  it("declares a role and a weight key shape consistent with its role", () => {
    for (const consideration of ITEM_CONSIDERATIONS) {
      expect(["attractor", "discount"]).toContain(consideration.role);
      // Discounts are physics/modifiers, never gametype policy.
      if (consideration.role === "discount") expect(consideration.weightKey).toBeNull();
    }
  });
});

describe("route_cost", () => {
  it("decreases monotonically with distance and never rewards being far", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const cost of [0, 100, 600, 1200, 3000, 10_000]) {
      const value = RouteCost.score(
        makeContext({ type: "armor", kind: "ra", health: 100, armor: 0, routeCost: cost, enemies: 1 }),
      );
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it("scores 0 for an unreachable goal so the gate, not the score, decides", () => {
    const ctx = makeContext({ type: "armor", kind: "ra", health: 100, armor: 0, routeCost: null, enemies: 1 });
    expect(RouteCost.score(ctx)).toBe(0);
  });

  it("penalises vertical travel more than horizontal", () => {
    const flat = estimateRouteCost({ x: 0, y: 0, z: 0 }, { x: 500, y: 0, z: 0 });
    const climb = estimateRouteCost({ x: 0, y: 0, z: 0 }, { x: 0, y: 500, z: 0 });
    expect(climb).toBeGreaterThan(flat);
  });
});

describe("danger", () => {
  it("is a discount: 1 when safe, lower when threatened", () => {
    const safe = Danger.score(
      makeContext({ type: "armor", kind: "ra", health: 100, armor: 0, routeCost: 100, enemies: 0 }),
    );
    const threatened = Danger.score(
      makeContext({ type: "armor", kind: "ra", health: 100, armor: 0, routeCost: 100, enemies: 3, damageTicksAgo: 5 }),
    );
    expect(safe).toBe(1);
    expect(threatened).toBeLessThan(safe);
  });

  it("decays as a hit recedes into the past", () => {
    const fresh = Danger.score(
      makeContext({ type: "armor", kind: "ra", health: 100, armor: 0, routeCost: 100, enemies: 1, damageTicksAgo: 5 }),
    );
    const stale = Danger.score(
      makeContext({
        type: "armor",
        kind: "ra",
        health: 100,
        armor: 0,
        routeCost: 100,
        enemies: 1,
        damageTicksAgo: 240,
      }),
    );
    expect(stale).toBeGreaterThan(fresh);
  });
});

describe("item_denial", () => {
  it("is zero with no live enemies — nothing to deny", () => {
    const ctx = makeContext({ type: "powerup", kind: "quad", health: 100, armor: 0, routeCost: 100, enemies: 0 });
    expect(ItemDenial.score(ctx)).toBe(0);
  });

  it("ranks quad above red armor above a shard", () => {
    const of = (type: PickupType, kind: string) =>
      ItemDenial.score(makeContext({ type, kind, health: 100, armor: 0, routeCost: 100, enemies: 2 }));
    expect(of("powerup", "quad")).toBeGreaterThan(of("armor", "ra"));
    expect(of("armor", "ra")).toBeGreaterThan(of("armor", "shard"));
  });
});

describe("item_value", () => {
  it("scores zero for an item that would grant nothing", () => {
    const full = makeContext({ type: "health", kind: "small", health: 100, armor: 0, routeCost: 100, enemies: 1 });
    expect(ItemValue.score(full)).toBe(0);
  });

  it("rises as the bot gets hurt", () => {
    const at90 = ItemValue.score(
      makeContext({ type: "health", kind: "medium", health: 90, armor: 0, routeCost: 100, enemies: 1 }),
    );
    const at30 = ItemValue.score(
      makeContext({ type: "health", kind: "medium", health: 30, armor: 0, routeCost: 100, enemies: 1 }),
    );
    expect(at30).toBeGreaterThan(at90);
  });

  it("leaves headroom above the largest ordinary pickup, so quad can lead", () => {
    // Regression: normalizing against 100 made a Mega saturate at 1.0, and
    // nothing could ever outrank it — including the one item a map places once.
    const mega = ItemValue.score(
      makeContext({ type: "health", kind: "mega", health: 100, armor: 0, routeCost: 100, enemies: 1 }),
    );
    const quad = ItemValue.score(
      makeContext({ type: "powerup", kind: "quad", health: 100, armor: 0, routeCost: 100, enemies: 1 }),
    );
    expect(mega).toBeLessThan(1);
    expect(quad).toBeGreaterThan(mega);
  });

  it("values an unowned weapon above ammo the bot cannot use", () => {
    const weapon = ItemValue.score(
      makeContext({ type: "weapon", kind: "rlauncher", health: 100, armor: 0, routeCost: 100, enemies: 1 }),
    );
    const deadAmmo = ItemValue.score(
      makeContext({ type: "ammo", kind: "rockets", health: 100, armor: 0, routeCost: 100, enemies: 1 }),
    );
    expect(weapon).toBeGreaterThan(deadAmmo);
  });
});
