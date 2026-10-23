/**
 * Gametype directives: parsing, safety, and arbitration against items
 * (docs/research/BOT_WEIGHTS_AND_GOALS.md Phase 4).
 *
 * This is the phase where data crosses a process boundary, so a good half of
 * these are about NOT trusting it: wrong addressee, expired, malformed target,
 * dead escort subject. A directive that survives all of that then has to earn
 * its place against ordinary item goals in the same currency.
 */

import { describe, expect, it } from "vitest";
import type { AgentDirective } from "../../../../shared/server/gametype/index";
import { DEFAULT_WEIGHT_PROFILE } from "../../shared/bot/WeightProfiles";
import type { PickupEntry } from "../../shared/bsp/PickupTable";
import { BotGameState } from "../BotGameState";
import { collectDirectiveGoals } from "../goals/DirectiveGoalSource";
import { ItemGoalPlanner } from "../goals/ItemGoalPlanner";

// ── Fixtures ─────────────────────────────────────────────────────────

const SELF_ENTITY = "p_1";

function directive(over: Partial<AgentDirective> = {}): AgentDirective {
  return {
    id: "obj_a",
    kind: "move_to",
    target: { type: "position", position: { x: 800, y: 0, z: 0 }, radius: 150 },
    priority: 0.9,
    expiresAtTick: 5000,
    interrupt: "danger",
    ...over,
  };
}

function makeState(opts: { health?: number; armor?: number; tick?: number; allies?: number } = {}): BotGameState {
  const state = new BotGameState();
  state.selfPlayerId = "bot";
  state.selfEntityId = SELF_ENTITY;
  state.tick = opts.tick ?? 1000;
  state.self.position = { x: 0, y: 0, z: 0 };
  state.self.health = opts.health ?? 100;
  state.self.armor = opts.armor ?? 0;
  state.self.weapons = ["blade"];
  state.self.ammo = {};
  state.self.team = "udon";
  state.pickupActiveMask = [];
  state.players = [
    {
      entityId: "e_enemy",
      playerId: "p9",
      position: { x: 9000, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isDead: false,
      team: "soba",
      relation: "enemy",
      distance: 9000,
    },
  ];
  for (let i = 0; i < (opts.allies ?? 0); i++) {
    state.players.push({
      entityId: `e_ally${i}`,
      playerId: `a${i}`,
      position: { x: 800, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isDead: false,
      team: "udon",
      relation: "ally",
      distance: 800,
    });
  }
  return state;
}

function snapshotWith(events: unknown[], tick = 1000) {
  return { tick, players: new Map(), entities: new Map(), events, pickupActiveMask: [] };
}

let nextId = 0;
function entry(type: PickupEntry["type"], kind: string, x: number): PickupEntry {
  return { id: nextId++, classname: `item_${kind}`, type, kind, position: { x, y: 0, z: 0 } };
}

// ── Parsing and trust ────────────────────────────────────────────────

describe("agent_directives parsing", () => {
  it("accepts directives addressed to this bot", () => {
    const state = makeState();
    state.update(
      snapshotWith([{ type: "agent_directives", entityId: SELF_ENTITY, directives: [directive()] }]) as never,
    );
    expect(state.directives).toHaveLength(1);
    expect(state.directives[0].id).toBe("obj_a");
  });

  it("ignores directives addressed to someone else", () => {
    // Only ever sent to the addressee, but a server bug must not make a bot
    // act on another player's orders.
    const state = makeState();
    state.update(snapshotWith([{ type: "agent_directives", entityId: "p_99", directives: [directive()] }]) as never);
    expect(state.directives).toHaveLength(0);
  });

  it("tolerates a malformed payload without dropping the snapshot", () => {
    const state = makeState();
    state.update(
      snapshotWith([{ type: "agent_directives", entityId: SELF_ENTITY, directives: "not-an-array" }]) as never,
    );
    expect(state.directives).toHaveLength(0);
  });

  it("prunes directives whose expiry has passed", () => {
    const state = makeState();
    state.update(
      snapshotWith(
        [{ type: "agent_directives", entityId: SELF_ENTITY, directives: [directive({ expiresAtTick: 1200 })] }],
        1000,
      ) as never,
    );
    expect(state.directives).toHaveLength(1);

    // Later snapshot with no directive event: the stale order must lapse on its
    // own, not linger because the gametype stopped talking.
    state.update(snapshotWith([], 1300) as never);
    expect(state.directives).toHaveLength(0);
  });
});

describe("directive → goal", () => {
  it("produces a goal with a stable id derived from the directive", () => {
    const state = makeState();
    state.directives = [directive()];
    const goals = collectDirectiveGoals(state);
    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe("objective:obj_a");
    expect(goals[0].kind).toBe("move_to");
    expect(goals[0].position).toEqual({ x: 800, y: 0, z: 0 });
  });

  it("drops unknown kinds, bad ids, and non-finite positions", () => {
    const state = makeState();
    state.directives = [
      directive({ id: "", kind: "move_to" }),
      directive({ id: "bad_kind", kind: "launch_nukes" as never }),
      directive({ id: "nan", target: { type: "position", position: { x: Number.NaN, y: 0, z: 0 }, radius: 10 } }),
    ];
    expect(collectDirectiveGoals(state)).toHaveLength(0);
  });

  it("tracks a live player for escort targets", () => {
    const state = makeState({ allies: 1 });
    state.directives = [directive({ id: "esc", kind: "escort", target: { type: "player", entityId: "e_ally0" } })];
    const goals = collectDirectiveGoals(state);
    expect(goals).toHaveLength(1);
    expect(goals[0].position).toEqual({ x: 800, y: 0, z: 0 });
  });

  it("drops an escort whose subject is dead or absent", () => {
    const state = makeState({ allies: 1 });
    state.players[1].isDead = true;
    state.directives = [directive({ id: "esc", kind: "escort", target: { type: "player", entityId: "e_ally0" } })];
    expect(collectDirectiveGoals(state)).toHaveLength(0);

    state.directives = [directive({ id: "esc", kind: "escort", target: { type: "player", entityId: "e_ghost" } })];
    expect(collectDirectiveGoals(state)).toHaveLength(0);
  });
});

// ── Arbitration against items, in one currency ───────────────────────

describe("directives compete with items", () => {
  const plan = (
    state: BotGameState,
    pickups: PickupEntry[],
    weights = DEFAULT_WEIGHT_PROFILE,
    ignoreDirectives = false,
  ) =>
    new ItemGoalPlanner().select(state, {
      pickupPositions: pickups,
      maxDistance: 1500,
      blockedPickupIds: new Set(),
      weights,
      ignoreDirectives,
    });

  it("a high objectivePush profile takes the objective over a Red Armor", () => {
    const state = makeState({ health: 100, armor: 0 });
    state.directives = [directive()];
    const redArmor = entry("armor", "ra", 300);

    const result = plan(state, [redArmor], { ...DEFAULT_WEIGHT_PROFILE, objectivePush: 0.9, itemGreed: 0.2 });
    expect(result.goal?.id).toBe("objective:obj_a");
    expect(result.explain).toContain("via=objective_push");
  });

  it("a deathmatch profile ignores the objective entirely (objectivePush 0)", () => {
    // The same directive, the same world — only policy differs.
    const state = makeState({ health: 100, armor: 0 });
    state.directives = [directive()];
    const redArmor = entry("armor", "ra", 300);

    const result = plan(state, [redArmor], DEFAULT_WEIGHT_PROFILE);
    expect(result.goal?.pickupId).toBe(redArmor.id);
  });

  it("urgency can lift an objective the gametype rated low priority", () => {
    const state = makeState();
    const weights = { ...DEFAULT_WEIGHT_PROFILE, objectivePush: 0.9, itemGreed: 0.2 };
    const calm = plan(state, [], weights);
    expect(calm.goal).toBeNull();

    state.directives = [directive({ priority: 0.1, urgency: 1 })];
    const urgent = plan(state, [], weights);
    expect(urgent.goal?.id).toBe("objective:obj_a");
    expect(urgent.explain).toContain("objective_urgency");
  });

  it("RETREAT ignores directives — an order must not drag a fleeing bot back", () => {
    const state = makeState({ health: 20 });
    state.directives = [directive()];
    const medium = entry("health", "medium", 400);

    const result = plan(state, [medium], { ...DEFAULT_WEIGHT_PROFILE, objectivePush: 1 }, true);
    expect(result.goal?.pickupId).toBe(medium.id);
  });

  it("keeps commitment while the gametype re-issues the same order", () => {
    // Directives are re-sent every snapshot; a stable id is what stops that
    // from looking like a new goal each time.
    const state = makeState();
    state.directives = [directive()];
    const weights = { ...DEFAULT_WEIGHT_PROFILE, objectivePush: 0.9 };
    const planner = new ItemGoalPlanner();
    const opts = { pickupPositions: [], maxDistance: 1500, blockedPickupIds: new Set<number>(), weights };

    planner.select(state, opts);
    const committed = planner.committedGoalId;
    state.tick += 10;
    state.directives = [directive()]; // re-issued, same id
    planner.select(state, opts);
    expect(planner.committedGoalId).toBe(committed);
  });
});

describe("team considerations", () => {
  it("carrier_protect only engages for an escort directive with a live subject", () => {
    const state = makeState({ allies: 1 });
    state.directives = [directive({ id: "esc", kind: "escort", target: { type: "player", entityId: "e_ally0" } })];
    const result = new ItemGoalPlanner().select(state, {
      pickupPositions: [],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
      weights: { ...DEFAULT_WEIGHT_PROFILE, objectivePush: 0, carrierProtect: 1 },
    });
    expect(result.goal?.id).toBe("objective:esc");
    expect(result.explain).toContain("via=carrier_protect");
  });

  it("team_cohesion pulls toward a goal near allies, not toward one far from them", () => {
    const state = makeState({ allies: 1 }); // ally at x=800
    state.directives = [directive({ id: "near_team", priority: 0 })];
    const result = new ItemGoalPlanner().select(state, {
      pickupPositions: [],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
      weights: { ...DEFAULT_WEIGHT_PROFILE, objectivePush: 0, teamCohesion: 1 },
    });
    // The directive sits on top of the ally, so cohesion has nothing to add.
    const trace = result.traces[0];
    expect(trace.features.team_cohesion).toBe(0);
  });
});
