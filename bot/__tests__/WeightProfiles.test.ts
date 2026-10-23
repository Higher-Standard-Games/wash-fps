/**
 * Weight profile selection and its effect on item choice
 * (docs/research/BOT_WEIGHTS_AND_GOALS.md Phase 2).
 *
 * The claim being tested is the whole point of the phase: a bot's behaviour
 * changes with the gametype through DATA alone, with no code difference and no
 * protocol change — the profile is chosen from `gametypeName`, which the server
 * has always sent and the bot used to discard.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHT_PROFILE,
  selectWeightProfile,
  WEIGHT_PROFILES,
  weightProfileKey,
} from "../../shared/bot/WeightProfiles";
import type { PickupEntry } from "../../shared/bsp/PickupTable";
import { BotGameState } from "../BotGameState";
import { ItemGoalPlanner } from "../goals/ItemGoalPlanner";

// ── Fixtures ─────────────────────────────────────────────────────────

let nextId = 0;
function entry(classname: string, type: PickupEntry["type"], kind: string, x: number): PickupEntry {
  return { id: nextId++, classname, type, kind, position: { x, y: 0, z: 0 } };
}

function makeState(opts: { health?: number; armor?: number; gametypeName?: string }): BotGameState {
  const state = new BotGameState();
  state.selfPlayerId = "bot";
  state.selfEntityId = "ent_bot";
  state.tick = 1000;
  state.self.position = { x: 0, y: 0, z: 0 };
  state.self.health = opts.health ?? 100;
  state.self.armor = opts.armor ?? 0;
  state.self.weapons = ["blade"];
  state.self.ammo = {};
  state.pickupActiveMask = [];
  state.players = [
    {
      entityId: "e0",
      playerId: "p0",
      position: { x: 5000, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isDead: false,
      team: "",
      relation: "enemy",
      distance: 5000,
    },
  ];
  if (opts.gametypeName !== undefined) {
    state.matchState = { gametypeName: opts.gametypeName, phase: 2 };
  }
  return state;
}

// ── Key normalization and resolution ─────────────────────────────────

describe("weightProfileKey", () => {
  it("normalizes display names into lookup keys", () => {
    expect(weightProfileKey("Deathmatch")).toBe("deathmatch");
    expect(weightProfileKey("Team Deathmatch")).toBe("team_deathmatch");
    expect(weightProfileKey("  Duel  ")).toBe("duel");
    // Dropped punctuation collapses rather than leaving a gap — "search_destroy",
    // not the "search__destroy" a naive strip would produce and nobody would guess.
    expect(weightProfileKey("Search & Destroy")).toBe("search_destroy");
  });

  it("is total — never throws on missing or junk input", () => {
    expect(weightProfileKey(undefined)).toBe("");
    expect(weightProfileKey(null)).toBe("");
    expect(weightProfileKey("")).toBe("");
  });
});

describe("selectWeightProfile", () => {
  it("resolves the shipped gametypes", () => {
    expect(selectWeightProfile("Deathmatch")).toBe(WEIGHT_PROFILES.deathmatch);
    expect(selectWeightProfile("Team Deathmatch")).toBe(WEIGHT_PROFILES.team_deathmatch);
    expect(selectWeightProfile("Duel")).toBe(WEIGHT_PROFILES.duel);
  });

  it("falls back to the default for unknown or absent gametypes", () => {
    // A bot that has not yet received match_state must still have a policy.
    expect(selectWeightProfile(undefined)).toBe(DEFAULT_WEIGHT_PROFILE);
    expect(selectWeightProfile("")).toBe(DEFAULT_WEIGHT_PROFILE);
    expect(selectWeightProfile("Capture The Flag")).toBe(DEFAULT_WEIGHT_PROFILE);
  });

  it("prefers the most specific key, then degrades gracefully", () => {
    // No role-specific profiles ship yet, so a role must not break resolution.
    expect(selectWeightProfile("Duel", "attacker", "post_plant")).toBe(WEIGHT_PROFILES.duel);
    expect(selectWeightProfile("Duel", "attacker")).toBe(WEIGHT_PROFILES.duel);
  });

  it("gives every profile a complete set of weights in range", () => {
    for (const [key, profile] of Object.entries(WEIGHT_PROFILES)) {
      for (const [field, value] of Object.entries(profile)) {
        expect(Number.isFinite(value), `${key}.${field}`).toBe(true);
        expect(value, `${key}.${field}`).toBeGreaterThanOrEqual(0);
        // majorItemBias is a multiplier on item value, not a 0..1 weight.
        expect(value, `${key}.${field}`).toBeLessThanOrEqual(field === "majorItemBias" ? 2 : 1);
      }
    }
  });
});

// ── Behaviour actually changes with the gametype ─────────────────────

describe("weights change item choice with no code difference", () => {
  it("a duel bot contests an item it cannot use; a deathmatch bot does not", () => {
    // At full armor a Red Armor grants nothing, so it is gated for both. The
    // separable case is a WEAPON the bot already owns: only denial makes it
    // worth taking, and duel weights denial three times as highly.
    const ownedWeapon = entry("weapon_rocketlauncher", "weapon", "rlauncher", 900);
    const nearShard = entry("item_armor_shard", "armor", "shard", 150);

    const state = makeState({ health: 100, armor: 0 });
    state.self.weapons = ["blade", "rlauncher"];
    state.self.ammo = { rlauncher: 20 }; // full, so value is ~0 — denial only

    const dm = new ItemGoalPlanner().select(state, {
      pickupPositions: [ownedWeapon, nearShard],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
      weights: WEIGHT_PROFILES.deathmatch,
    });
    const duel = new ItemGoalPlanner().select(state, {
      pickupPositions: [ownedWeapon, nearShard],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
      weights: WEIGHT_PROFILES.duel,
    });

    const dmWeapon = dm.traces.find((t) => t.goalId.endsWith(String(ownedWeapon.id)));
    const duelWeapon = duel.traces.find((t) => t.goalId.endsWith(String(ownedWeapon.id)));
    expect(duelWeapon?.desire).toBeGreaterThan(dmWeapon?.desire ?? 0);
  });

  it("itemGreed 0 makes a bot ignore items entirely (Clan Arena / Instagib shape)", () => {
    const mega = entry("item_health_mega", "health", "mega", 300);
    const result = new ItemGoalPlanner().select(makeState({ health: 50 }), {
      pickupPositions: [mega],
      maxDistance: 1500,
      blockedPickupIds: new Set(),
      weights: { ...DEFAULT_WEIGHT_PROFILE, itemGreed: 0, itemDenial: 0 },
    });
    // Nothing is attractive, so nothing is chosen — the bot goes and fights.
    expect(result.goal).toBeNull();
  });

  it("low riskTolerance suppresses item runs while threatened", () => {
    const mega = entry("item_health_mega", "health", "mega", 400);
    const state = makeState({ health: 60 });
    state.recentDamage = [
      { attackerId: "p0", damage: 40, tick: state.tick - 5, weaponId: "machinegun", position: { x: 0, y: 0, z: 0 } },
    ];

    const opts = { pickupPositions: [mega], maxDistance: 1500, blockedPickupIds: new Set<number>() };
    const bold = new ItemGoalPlanner().select(state, {
      ...opts,
      weights: { ...DEFAULT_WEIGHT_PROFILE, riskTolerance: 1 },
    });
    const timid = new ItemGoalPlanner().select(state, {
      ...opts,
      weights: { ...DEFAULT_WEIGHT_PROFILE, riskTolerance: 0 },
    });

    expect(bold.desire).toBeGreaterThan(timid.desire);
    // Both still choose it — danger discounts, it does not veto.
    expect(timid.goal).not.toBeNull();
  });
});

// ── Selection is driven by match_state, end to end ───────────────────

describe("gametype reaches the planner through match_state", () => {
  it("uses the profile for the gametype the server reported", () => {
    const ownedWeapon = entry("weapon_rocketlauncher", "weapon", "rlauncher", 900);
    const opts = { pickupPositions: [ownedWeapon], maxDistance: 1500, blockedPickupIds: new Set<number>() };

    const dmState = makeState({ gametypeName: "Deathmatch" });
    dmState.self.weapons = ["blade", "rlauncher"];
    dmState.self.ammo = { rlauncher: 20 };

    const duelState = makeState({ gametypeName: "Duel" });
    duelState.self.weapons = ["blade", "rlauncher"];
    duelState.self.ammo = { rlauncher: 20 };

    const dm = new ItemGoalPlanner().select(dmState, opts);
    const duel = new ItemGoalPlanner().select(duelState, opts);
    expect(duel.desire).toBeGreaterThan(dm.desire);
  });

  it("parses gametype context out of a match_state snapshot event", () => {
    const state = new BotGameState();
    state.selfPlayerId = "bot";
    state.selfEntityId = "ent_bot";
    // Shaped as SnapshotBuilder emits it: MatchStateSnapshot fields spread in.
    const snapshot = {
      tick: 5,
      players: new Map(),
      entities: new Map(),
      events: [
        {
          type: "match_state",
          phase: 2,
          gametypeName: "Team Deathmatch",
          teamRoles: { udon: "attacker", soba: "defender" },
          roundState: "pre_plant",
        },
      ],
      pickupActiveMask: [],
    };
    state.update(snapshot as never);

    expect(state.matchState.gametypeName).toBe("Team Deathmatch");
    expect(state.matchState.phase).toBe(2);
    expect(state.matchState.roundState).toBe("pre_plant");
  });

  it("reports the bot's own round role from its team", () => {
    const state = makeState({ gametypeName: "snd" });
    state.matchState = {
      gametypeName: "snd",
      phase: 2,
      teamRoles: { udon: "attacker", soba: "defender" },
    };
    state.self.team = "soba";
    expect(state.getOwnRole()).toBe("defender");
  });

  it("has no role in FFA, and does not invent one", () => {
    const state = makeState({ gametypeName: "Deathmatch" });
    expect(state.getOwnRole()).toBeNull();
  });
});
