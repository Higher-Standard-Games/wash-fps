/**
 * Golden-scenario coverage for scored item selection
 * (docs/research/BOT_WEIGHTS_AND_GOALS.md §7.6).
 *
 * These are behavioural fixtures, not unit tests of arithmetic: each states a
 * situation and the item a competent player would take. They are the regression
 * net for weight and curve tuning — the thing that catches "raising health
 * urgency broke armor selection" before a playtest does.
 *
 * The acceptance test for the whole phase is in "quad needs no special case":
 * if quad only ranks correctly because something named quad exists in the
 * scoring path, the design is wrong.
 */

import { describe, expect, it } from "vitest";
import type { PickupEntry } from "../../shared/bsp/PickupTable";
import { BotGameState } from "../BotGameState";
import { mistakeProbability } from "../goals/GoalArbiter";
import { ItemGoalPlanner } from "../goals/ItemGoalPlanner";

// ── Fixture helpers ──────────────────────────────────────────────────

let nextId = 0;
function entry(classname: string, type: PickupEntry["type"], kind: string, x: number, amount?: number): PickupEntry {
  return { id: nextId++, classname, type, kind, amount, position: { x, y: 0, z: 0 } };
}

/**
 * Minimal BotGameState standing in for a live snapshot. Only the fields the
 * item considerations read are populated; anything else would be noise.
 */
function makeState(opts: {
  health?: number;
  armor?: number;
  weapons?: string[];
  ammo?: Record<string, number>;
  enemies?: number;
  activeMask?: boolean[];
  tick?: number;
}): BotGameState {
  const state = new BotGameState();
  state.selfPlayerId = "bot";
  state.selfEntityId = "ent_bot";
  state.tick = opts.tick ?? 1000;
  state.self.position = { x: 0, y: 0, z: 0 };
  state.self.health = opts.health ?? 100;
  state.self.armor = opts.armor ?? 0;
  state.self.weapons = opts.weapons ?? ["blade"];
  state.self.ammo = opts.ammo ?? {};
  state.self.isDead = false;
  state.pickupActiveMask = opts.activeMask ?? [];
  state.players = [];
  for (let i = 0; i < (opts.enemies ?? 1); i++) {
    state.players.push({
      entityId: `e${i}`,
      playerId: `p${i}`,
      position: { x: 5000, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isDead: false,
      team: "",
      relation: "enemy",
      distance: 5000,
    });
  }
  return state;
}

function choose(state: BotGameState, pickups: PickupEntry[], typeFilter?: Set<string>) {
  const planner = new ItemGoalPlanner();
  return planner.select(state, {
    pickupPositions: pickups,
    maxDistance: 1500,
    blockedPickupIds: new Set(),
    typeFilter,
  });
}

// ── Scenarios ────────────────────────────────────────────────────────

describe("item goal selection — tier beats proximity", () => {
  it("prefers Red Armor over a much closer health bubble at 95hp/0ap", () => {
    // The exact case the old getNearestPickup() got wrong: nearest wins, always.
    const bubble = entry("item_health_small", "health", "small", 200);
    const redArmor = entry("item_armor_ra", "armor", "ra", 700);
    const result = choose(makeState({ health: 95, armor: 0 }), [bubble, redArmor]);
    expect(result.goal?.pickupId).toBe(redArmor.id);
  });

  it("prefers Mega Health over a closer medium at full health", () => {
    const medium = entry("item_health_medium", "health", "medium", 250);
    const mega = entry("item_health_mega", "health", "mega", 800);
    const result = choose(makeState({ health: 100 }), [medium, mega]);
    // Medium grants 0 at full health and is gated out entirely; mega overheals.
    expect(result.goal?.pickupId).toBe(mega.id);
  });

  it("still takes the near item when the far one is only marginally better", () => {
    // Route cost has to actually matter, or bots sprint across the map forever.
    const nearYa = entry("item_armor_ya", "armor", "ya", 150);
    const farRa = entry("item_armor_ra", "armor", "ra", 1400);
    const result = choose(makeState({ health: 100, armor: 50 }), [nearYa, farRa]);
    expect(result.goal?.pickupId).toBe(nearYa.id);
  });
});

describe("item goal selection — overcap and gating", () => {
  it("gates out a health bubble at full health rather than scoring it low", () => {
    // The server refuses this pickup (`after <= before`), so a bot that walks to
    // one stands on it forever. It must not be a candidate at all.
    const bubble = entry("item_health_small", "health", "small", 100);
    const result = choose(makeState({ health: 100 }), [bubble]);
    expect(result.goal).toBeNull();
    expect(result.traces[0].gate).toBe(0);
    expect(result.traces[0].gateReason).toBe("no_gain");
  });

  it("gates out armor when the plate model would grant nothing", () => {
    const green = entry("item_armor_ga", "armor", "ga", 100);
    const result = choose(makeState({ health: 100, armor: 100 }), [green]);
    expect(result.goal).toBeNull();
    expect(result.traces[0].gateReason).toBe("no_gain");
  });

  it("values a partial-plate armor top-up correctly (58 + green -> 75)", () => {
    const green = entry("item_armor_ga", "armor", "ga", 100);
    const result = choose(makeState({ health: 100, armor: 58 }), [green]);
    expect(result.goal?.pickupId).toBe(green.id);
  });

  it("skips pickups the authoritative mask says are collected", () => {
    const mega = entry("item_health_mega", "health", "mega", 300);
    const medium = entry("item_health_medium", "health", "medium", 600);
    const mask: boolean[] = [];
    mask[mega.id] = false; // taken
    mask[medium.id] = true;
    const result = choose(makeState({ health: 50, activeMask: mask }), [mega, medium]);
    expect(result.goal?.pickupId).toBe(medium.id);
  });
});

describe("item goal selection — need scales value", () => {
  it("takes health over a minor armor top-up when badly hurt", () => {
    const medium = entry("item_health_medium", "health", "medium", 400);
    const shard = entry("item_armor_shard", "armor", "shard", 400);
    const result = choose(makeState({ health: 20, armor: 0 }), [medium, shard]);
    expect(result.goal?.pickupId).toBe(medium.id);
  });

  it("still takes Yellow Armor over a medium health at 20hp — effective HP, not folk wisdom", () => {
    // Worth locking in, because it reads wrong at a glance. With armor
    // absorbing ~66% of incoming damage, 20hp + 50ap survives ~59 damage while
    // 45hp + 0ap survives 45. The armor is the better pickup.
    //
    // The "I am fleeing, get me health" case is handled by RETREAT's type
    // filter (below), not by distorting item value.
    const medium = entry("item_health_medium", "health", "medium", 400);
    const yellow = entry("item_armor_ya", "armor", "ya", 400);
    const result = choose(makeState({ health: 20, armor: 0 }), [medium, yellow]);
    expect(result.goal?.pickupId).toBe(yellow.id);
  });

  it("takes armor over health when healthy", () => {
    const medium = entry("item_health_medium", "health", "medium", 400);
    const yellow = entry("item_armor_ya", "armor", "ya", 400);
    const result = choose(makeState({ health: 90, armor: 0 }), [medium, yellow]);
    expect(result.goal?.pickupId).toBe(yellow.id);
  });

  it("ignores ammo for a weapon it does not own, in favour of one it does", () => {
    const uselessAmmo = entry("ammo_rocketlauncher", "ammo", "rockets", 150, 10);
    const usefulAmmo = entry("ammo_machinegun", "ammo", "bullets", 600, 50);
    const state = makeState({ health: 100, weapons: ["blade", "machinegun"], ammo: { machinegun: 10 } });
    const result = choose(state, [uselessAmmo, usefulAmmo]);
    expect(result.goal?.pickupId).toBe(usefulAmmo.id);
  });

  it("prefers a weapon it lacks over ammo it can already use", () => {
    const ammo = entry("ammo_machinegun", "ammo", "bullets", 200, 50);
    const weapon = entry("weapon_rocketlauncher", "weapon", "rlauncher", 500);
    const state = makeState({ health: 100, weapons: ["blade", "machinegun"], ammo: { machinegun: 60 } });
    const result = choose(state, [ammo, weapon]);
    expect(result.goal?.pickupId).toBe(weapon.id);
  });
});

describe("item goal selection — quad needs no special case", () => {
  it("outranks every ordinary item at comparable range", () => {
    // The Phase 1 acceptance test. Quad wins through item_value + item_denial,
    // not through any quad-shaped branch in the arbiter.
    const quad = entry("item_quad", "powerup", "quad", 600);
    const redArmor = entry("item_armor_ra", "armor", "ra", 550);
    const mega = entry("item_health_mega", "health", "mega", 500);
    const result = choose(makeState({ health: 60, armor: 0 }), [redArmor, mega, quad]);
    expect(result.goal?.pickupId).toBe(quad.id);
    expect(result.explain).toContain("powerup:quad");
  });

  it("loses to health when the bot is nearly dead", () => {
    // A quad collected at 8 HP is a quad handed to the enemy.
    const quad = entry("item_quad", "powerup", "quad", 700);
    const mega = entry("item_health_mega", "health", "mega", 250);
    const result = choose(makeState({ health: 8, armor: 0 }), [quad, mega]);
    expect(result.goal?.pickupId).toBe(mega.id);
  });

  it("is still worth crossing the map for when healthy", () => {
    const quad = entry("item_quad", "powerup", "quad", 1400);
    const shard = entry("item_armor_shard", "armor", "shard", 120);
    const result = choose(makeState({ health: 100, armor: 0 }), [quad, shard]);
    expect(result.goal?.pickupId).toBe(quad.id);
  });
});

describe("item goal selection — retreat filter", () => {
  it("only considers health when retreating, even if armor scores higher", () => {
    const medium = entry("item_health_medium", "health", "medium", 500);
    const redArmor = entry("item_armor_ra", "armor", "ra", 300);
    const state = makeState({ health: 30, armor: 0 });
    const open = choose(state, [medium, redArmor]);
    const retreating = choose(state, [medium, redArmor], new Set(["health"]));
    // Open shopping may well prefer the armor; retreating must not.
    expect(retreating.goal?.pickupId).toBe(medium.id);
    expect(open.goal).not.toBeNull();
  });
});

describe("goal commitment", () => {
  it("keeps the same goal across ticks instead of thrashing between near-equals", () => {
    const a = entry("item_armor_ya", "armor", "ya", 400);
    const b = entry("item_armor_ya", "armor", "ya", 405); // all but identical
    const planner = new ItemGoalPlanner();
    const opts = { pickupPositions: [a, b], maxDistance: 1500, blockedPickupIds: new Set<number>() };

    const state = makeState({ health: 100, armor: 0, tick: 1000 });
    const first = planner.select(state, opts);
    expect(first.goal).not.toBeNull();

    // Nudge the world so raw scores swap order slightly.
    state.tick = 1010;
    state.self.position = { x: 3, y: 0, z: 0 };
    const second = planner.select(state, opts);
    expect(second.goal?.id).toBe(first.goal?.id);
  });

  it("releases commitment on reset so a respawned bot re-decides", () => {
    const item = entry("item_armor_ya", "armor", "ya", 400);
    const planner = new ItemGoalPlanner();
    const opts = { pickupPositions: [item], maxDistance: 1500, blockedPickupIds: new Set<number>() };
    planner.select(makeState({ health: 100, armor: 0 }), opts);
    expect(planner.committedGoalId).not.toBeNull();
    planner.reset();
    expect(planner.committedGoalId).toBeNull();
  });
});

describe("mistakes (BotDifficulty.mistakeRate)", () => {
  const mega = () => entry("item_health_mega", "health", "mega", 300);
  const medium = () => entry("item_health_medium", "health", "medium", 320);

  it("is deterministic at mistakeRate 0 — the fixtures above depend on this", () => {
    const best = mega();
    const other = medium();
    const opts = { pickupPositions: [best, other], maxDistance: 1500, blockedPickupIds: new Set<number>() };
    for (let i = 0; i < 20; i++) {
      const result = new ItemGoalPlanner(0).select(makeState({ health: 40 }), opts);
      expect(result.goal?.pickupId).toBe(best.id);
    }
  });

  it("takes the runner-up when the roll succeeds, and says so", () => {
    const best = mega();
    const other = medium();
    const result = new ItemGoalPlanner(16, () => 0).select(makeState({ health: 40 }), {
      pickupPositions: [best, other],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
    });
    expect(result.goal?.pickupId).toBe(other.id);
    expect(result.explain).toContain("[mistake: took runner-up]");
  });

  it("takes the winner when the roll fails", () => {
    const best = mega();
    const other = medium();
    // rate 8 -> p = 0.5, so a roll of 0.99 must miss. (rate 16 is p = 1.0,
    // where nothing ever misses — which is what this test caught first time.)
    const result = new ItemGoalPlanner(8, () => 0.99).select(makeState({ health: 40 }), {
      pickupPositions: [best, other],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
    });
    expect(result.goal?.pickupId).toBe(best.id);
    expect(result.explain).not.toContain("mistake");
  });

  it("never picks a gated candidate as the mistake", () => {
    // A mistake is a plausible misjudgement, not an impossible one: an item the
    // server would refuse must stay unreachable through every path.
    const best = mega();
    const uncollectable = entry("item_health_small", "health", "small", 100);
    const state = makeState({ health: 100 }); // bubble grants nothing
    const result = new ItemGoalPlanner(16, () => 0).select(state, {
      pickupPositions: [best, uncollectable],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
    });
    expect(result.goal?.pickupId).toBe(best.id);
  });

  it("maps difficulty presets onto sane probabilities", () => {
    // easy 8, medium 3, hard 1, expert 0.2 — monotonic, bounded, 0 for none.
    expect(mistakeProbability(0)).toBe(0);
    expect(mistakeProbability(0.2)).toBeLessThan(mistakeProbability(1));
    expect(mistakeProbability(1)).toBeLessThan(mistakeProbability(3));
    expect(mistakeProbability(3)).toBeLessThan(mistakeProbability(8));
    expect(mistakeProbability(8)).toBeLessThanOrEqual(1);
    expect(mistakeProbability(1000)).toBe(1);
  });
});

describe("decision explanation", () => {
  it("names the goal, the winning consideration, and the runner-up", () => {
    const mega = entry("item_health_mega", "health", "mega", 300);
    const bubble = entry("item_health_small", "health", "small", 900);
    const result = choose(makeState({ health: 40 }), [mega, bubble]);
    expect(result.explain).toContain("goal=item:pickup:");
    expect(result.explain).toContain("via=item_value");
    expect(result.explain).toContain("next=");
  });

  it("reports why everything was rejected when nothing is worth taking", () => {
    const bubble = entry("item_health_small", "health", "small", 100);
    const result = choose(makeState({ health: 100 }), [bubble]);
    expect(result.explain).toContain("goal=none");
    expect(result.explain).toContain("gated=1");
  });
});

// ── Unreachable goals ────────────────────────────────────────────────

describe("the unreachable gate", () => {
  /** A directive to somewhere with no route to it. */
  const order = {
    id: "snd_plant_site_0",
    kind: "move_to" as const,
    target: { type: "position" as const, position: { x: 9000, y: 0, z: 9000 }, radius: 96 },
    priority: 0.9,
    expiresAtTick: 100_000,
    interrupt: "never" as const,
  };

  /** A nav graph that can route nowhere — the fragmented case, exaggerated. */
  const noRoutes = { estimateTravelCost: () => null } as never;

  it("still pursues an objective the nav graph cannot route to", () => {
    // The graph links nodes only when they have clear line of sight, so on any
    // map with corners it fragments into per-room islands — 4-10% of node pairs
    // routable on the shipped maps. Gating objectives on that made bots ignore
    // the bomb rather than approach it badly.
    const state = makeState({});
    state.matchState = { gametypeName: "Search & Destroy", phase: 2, teamRoles: {}, roundState: "pre_plant" };
    state.directives = [order];

    const result = new ItemGoalPlanner().select(state, {
      pickupPositions: [],
      maxDistance: 3000,
      blockedPickupIds: new Set(),
      navGraph: noRoutes,
    });
    expect(result.goal?.id).toContain("snd_plant_site_0");
  });

  it("still drops an ITEM it cannot route to", () => {
    // An item behind a wall is worthless, and a bot that walks at one stands
    // there forever. The gate has to keep applying to those.
    const redArmor = entry("item_armor_ra", "armor", "ra", 9000);
    const result = new ItemGoalPlanner().select(makeState({ armor: 0 }), {
      pickupPositions: [redArmor],
      maxDistance: 30_000,
      blockedPickupIds: new Set(),
      navGraph: noRoutes,
    });
    expect(result.goal).toBeNull();
  });
});

describe("item goal selection — the mode's policy on major items", () => {
  // Armed with a working pair; a third gun close by, the Red Armor further off.
  const armedState = (gametypeName: string) => {
    const state = makeState({
      health: 100,
      armor: 0,
      weapons: ["blade", "rlauncher", "plasmagun"],
      ammo: { rlauncher: 10, plasmagun: 100 },
    });
    state.matchState.gametypeName = gametypeName;
    return state;
  };
  const thirdGun = () => entry("weapon_lasergun", "weapon", "lasergun", 300);
  const redArmor = () => entry("item_armor_ra", "armor", "ra", 700);

  it("in Duel, takes the Red Armor over a third gun", () => {
    const armor = redArmor();
    expect(choose(armedState("Duel"), [thirdGun(), armor]).goal?.pickupId).toBe(armor.id);
  });

  it("in Amphi, played for frags, the armor counts for less", () => {
    const duel = choose(armedState("Duel"), [redArmor()]).desire;
    const amphi = choose(armedState("Amphi"), [redArmor()]).desire;
    expect(amphi).toBeLessThan(duel);
  });
});

describe("item goal selection — Duel item timing", () => {
  // The Red Armor (gain 100) taken at tick 1000, back at 1000 + 25 s. 640 units off.
  function duelBotWaitingOnArmor(tick: number) {
    const state = makeState({ health: 100, armor: 0, weapons: ["blade", "rlauncher", "plasmagun"], tick });
    state.matchState.gametypeName = "Duel";
    const armor = entry("item_armor_ra", "armor", "ra", 640);
    const mask: boolean[] = [];
    mask[armor.id] = false;
    state.pickupActiveMask = mask;
    state.itemTakenTick.set(armor.id, 1000);
    return { state, armor };
  }

  it("does not leave for a returning armor while it is still far off in time", () => {
    const { state, armor } = duelBotWaitingOnArmor(1000 + 5 * 125);
    const result = choose(state, [armor]);
    expect(result.goal).toBeNull();
    expect(result.traces.find((t) => t.goalId.endsWith(`:${armor.id}`))?.gateReason).toBe("not_yet");
  });

  it("heads for it in time to be there when it returns", () => {
    const { state, armor } = duelBotWaitingOnArmor(1000 + 22 * 125);
    const result = choose(state, [armor]);
    expect(result.goal?.pickupId).toBe(armor.id);
    expect(result.goal?.respawnTick).toBe(1000 + 25 * 125);
  });
});
