/**
 * Search & Destroy: the round rules, and the orders it gives bots.
 *
 * `BombModel` and `MatchState` are tested on their own, so what is exercised
 * here is the wiring nobody else covers — reading the map, placing the bomb for
 * whichever side is attacking this round, and the asymmetric elimination rule
 * that makes an armed bomb outlive its attackers.
 */

import { describe, expect, it } from "vitest";
import type { AgentDirectiveContext } from "../../../../../shared/server/gametype";
import { DEFAULT_LOADOUT } from "../../../../../shared/server/gametype/Loadout";
import type { GametypeMapContext, GametypeTickContext } from "../BaseGametype";
import { Deathmatch } from "../Deathmatch";
import { SearchAndDestroy } from "../SearchAndDestroy";

// ── Fixtures ─────────────────────────────────────────────────────────

const entity = (classname: string, properties: Record<string, string> = {}) => ({ classname, properties });

/**
 * Two sites with no brush volumes — the radius-fallback path, which covers half
 * the shipped bomb maps. Team spawns are present because `isBombMap` requires
 * them: capture areas alone appear on wdm4/wdm9, which are not bomb maps.
 */
const MAP_ENTITIES = [
  entity("misc_capture_area_indicator", { origin: "0 0 0", targetname: "bombsitea0" }),
  entity("misc_capture_area_indicator", { origin: "4000 0 0", targetname: "bombsiteb0" }),
  entity("team_CTF_alphaspawn", { origin: "-2000 0 0" }),
  entity("team_CTF_betaspawn", { origin: "6000 0 0" }),
];

const UDON_SPAWNS = [{ x: -2000, y: 0, z: 0 }];
const SOBA_SPAWNS = [{ x: 6000, y: 0, z: 0 }];

function mapContext(over: Partial<GametypeMapContext> = {}): GametypeMapContext {
  return {
    entities: MAP_ENTITIES as never,
    models: [],
    teamSpawnPoints: new Map([
      ["udon", UDON_SPAWNS],
      ["soba", SOBA_SPAWNS],
    ]),
    collision: null,
    ...over,
  };
}

interface FakePlayer {
  id: number;
  ownerId: number;
  team: string;
  position: { x: number; y: number; z: number };
  speed?: number;
  dead?: boolean;
}

function fakeState(players: FakePlayer[]) {
  return {
    entitiesByType: () =>
      players.map((p) => ({
        id: p.id,
        ownerId: p.ownerId,
        health: { dead: !!p.dead },
        transform: { position: p.position },
        physics: { velocity: { x: p.speed ?? 0, y: 0, z: 0 } },
      })),
  } as never;
}

function tickContext(over: Partial<GametypeTickContext> & { players: FakePlayer[] }): GametypeTickContext {
  const teams = new Map(over.players.map((p) => [p.ownerId, p.team]));
  const attacking = over.attackingTeam ?? "udon";
  return {
    tick: 0 as never,
    round: 1,
    live: true,
    attackingTeam: attacking,
    defendingTeam: attacking === "udon" ? "soba" : "udon",
    teamOf: (id: number) => (teams.get(id) ?? "spectator") as never,
    ...over,
  };
}

/** Run `ticks` ticks from `from`, returning the first outcome. */
function run(mode: SearchAndDestroy, players: FakePlayer[], ticks: number, from = 0, over = {}) {
  const state = fakeState(players);
  for (let i = 0; i < ticks; i++) {
    const outcome = mode.onTick(state, tickContext({ players, tick: (from + i) as never, ...over }));
    if (outcome) return outcome;
  }
  return null;
}

/** A mode with the map loaded and the bomb placed for round 1. */
function loaded(over: Partial<GametypeMapContext> = {}): SearchAndDestroy {
  const mode = new SearchAndDestroy();
  mode.onMapLoad(mapContext(over));
  startRound(mode, 1, "udon");
  return mode;
}

/** Begin a round, the way the controller does at the top of the freeze. */
function startRound(mode: SearchAndDestroy, round: number, attackingTeam: "udon" | "soba") {
  mode.onRoundStart(fakeState([]), tickContext({ players: [], live: false, round, attackingTeam }));
}

// ── Configuration ────────────────────────────────────────────────────

describe("match shape", () => {
  it("plays in rounds, with the swap before the limit and a two-round lead", () => {
    const config = new SearchAndDestroy().getMatchConfig();
    expect(config.roundBased).toBe(true);
    expect(config.leadRequired).toBe(2);
    // The swap must land before the limit could be reached, or a team could win
    // the match without ever having defended.
    expect(config.roundsPerHalf).toBeLessThan(config.scoreLimit);
  });

  it("spawns players armed and armored, because every round is a full fight", () => {
    const loadout = new SearchAndDestroy().getSpawnLoadout();
    expect(loadout.weapons.length).toBeGreaterThan(1);
    expect(loadout.armor).toBe(100);
  });
});

// ── Map reading ──────────────────────────────────────────────────────

describe("map load", () => {
  it("reads the bombsites", () => {
    const mode = loaded();
    expect(mode.getAgentDirectives(directiveContext({ teamId: "soba" }), fakeState([]))).not.toHaveLength(0);
  });

  it("survives a map with no bombsites rather than crashing at load", () => {
    const mode = new SearchAndDestroy();
    expect(() => mode.onMapLoad(mapContext({ entities: [] }))).not.toThrow();
    expect(mode.getAgentDirectives(directiveContext({}), fakeState([]))).toHaveLength(0);
  });

  it("starts the bomb at the attacking team's spawn, and follows the swap", () => {
    const mode = loaded();
    expect(mode.bombState.position.x).toBeCloseTo(UDON_SPAWNS[0].x, 0);

    // Second half: soba attacks, so the bomb starts on their side instead.
    startRound(mode, 10, "soba");
    expect(mode.bombState.position.x).toBeCloseTo(SOBA_SPAWNS[0].x, 0);
  });

  it("does not disturb a carried bomb during the round", () => {
    const mode = loaded();
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: UDON_SPAWNS[0] };
    run(mode, [carrier], 1);
    expect(mode.bombState.carrierId).toBe(1);

    // Freeze ticks keep arriving in a real match only between rounds, but a
    // non-live tick must never reach in and reset the bomb.
    mode.onTick(fakeState([carrier]), tickContext({ players: [carrier], live: false }));
    expect(mode.bombState.carrierId).toBe(1);
  });
});

// ── Round outcomes ───────────────────────────────────────────────────

describe("round outcomes", () => {
  const attacker = (over: Partial<FakePlayer> = {}): FakePlayer => ({
    id: 1,
    ownerId: 1,
    team: "udon",
    position: { x: 0, y: 0, z: 0 },
    ...over,
  });
  const defender = (over: Partial<FakePlayer> = {}): FakePlayer => ({
    id: 2,
    ownerId: 2,
    team: "soba",
    position: { x: 3000, y: 0, z: 0 },
    ...over,
  });

  it("gives the round to the attackers when every defender dies", () => {
    // Asymmetric by design: nothing can stop the plant, so it is over.
    const mode = loaded();
    const outcome = run(mode, [attacker({ position: UDON_SPAWNS[0] }), defender({ dead: true })], 2);
    expect(outcome?.winner).toBe("udon");
  });

  it("gives the round to the defenders when every attacker dies before the arm", () => {
    const mode = loaded();
    const outcome = run(mode, [attacker({ dead: true }), defender()], 2);
    expect(outcome?.winner).toBe("soba");
  });

  it("does not end the round when the last attacker dies with the bomb armed", () => {
    // The tensest thing in the mode: the defenders still have to walk over and
    // defuse it. Ending here would delete the retake.
    const { mode, armedAt } = armed();
    const outcome = run(mode, [attacker({ dead: true }), defender()], 2, armedAt);
    expect(outcome).toBeNull();
  });

  it("does not award an empty round to anybody", () => {
    const mode = loaded();
    expect(run(mode, [], 5)).toBeNull();
  });

  it("gives the round to the defenders when time runs out unarmed", () => {
    const mode = loaded();
    run(mode, [attacker()], 1);
    expect(mode.onRoundTimeExpired(fakeState([]))?.winner).toBe("soba");
  });

  it("lets an armed bomb outlive the round timer", () => {
    // Null means "the round continues" — once the bomb is ticking its own timer
    // is the clock.
    expect(armed().mode.onRoundTimeExpired(fakeState([]))).toBeNull();
  });

  /**
   * A mode whose bomb is planted and armed at site A, attacked by udon.
   *
   * The far-away defender is not decoration: without a live defender the round
   * ends on elimination before the bomb ever gets armed.
   */
  function armed(): { mode: SearchAndDestroy; armedAt: number } {
    const mode = loaded();
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: UDON_SPAWNS[0] };
    const watcher = defender();
    run(mode, [carrier, watcher], 1);
    expect(mode.bombState.carrierId).toBe(1);

    // Walk into the site slowly enough to plant, then hold to arm.
    const planting = { ...carrier, position: { x: 0, y: 0, z: 0 }, speed: 10 };
    run(mode, [planting, watcher], 1, 1);
    expect(mode.bombState.phase).toBe("planted");

    const armTicks = 4 * 125 + 10;
    const outcome = run(mode, [planting, watcher], armTicks, 2);
    expect(outcome).toBeNull();
    expect(mode.bombState.phase).toBe("armed");
    return { mode, armedAt: 2 + armTicks };
  }

  it("gives the round to the defenders on a defuse", () => {
    const { mode, armedAt } = armed();
    const defuser = defender({ position: { x: 0, y: 0, z: 0 } });
    const outcome = run(mode, [attacker(), defuser], 7 * 125 + 10, armedAt);
    expect(outcome?.winner).toBe("soba");
    expect(outcome?.reason).toContain("defused");
  });

  it("gives the round to the attackers on a detonation", () => {
    const { mode, armedAt } = armed();
    const outcome = run(mode, [attacker(), defender()], 30 * 125 + 10, armedAt);
    expect(outcome?.winner).toBe("udon");
    expect(outcome?.reason).toContain("detonated");
  });
});

// ── Directives ───────────────────────────────────────────────────────

function directiveContext(over: Partial<AgentDirectiveContext>): AgentDirectiveContext {
  return {
    tick: 1000,
    playerId: 1,
    entityId: "p_1",
    teamId: "udon",
    position: { x: 0, y: 0, z: 0 },
    alive: true,
    teamOf: () => "udon",
    ...over,
  };
}

describe("agent directives", () => {
  it("issues nothing to the dead or to spectators", () => {
    const mode = loaded();
    expect(mode.getAgentDirectives(directiveContext({ alive: false }), fakeState([]))).toHaveLength(0);
    expect(mode.getAgentDirectives(directiveContext({ teamId: "spectator" }), fakeState([]))).toHaveLength(0);
  });

  it("sends defenders to both sites, so they spread without assignment logic", () => {
    const mode = loaded();
    const directives = mode.getAgentDirectives(directiveContext({ teamId: "soba" }), fakeState([]));
    expect(directives).toHaveLength(2);
    expect(new Set(directives.map((d) => d.id)).size).toBe(2);
  });

  it("tells attackers to fetch a loose bomb", () => {
    const mode = loaded();
    const [directive] = mode.getAgentDirectives(directiveContext({ teamId: "udon" }), fakeState([]));
    expect(directive.id).toBe("snd_fetch_bomb");
    expect(directive.kind).toBe("move_to");
  });

  it("ranks a defuse above everything else it ever issues", () => {
    const mode = new SearchAndDestroy();
    mode.onMapLoad(mapContext());
    mode.onTick(fakeState([]), tickContext({ players: [], live: false }));
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: UDON_SPAWNS[0] };
    const watcher: FakePlayer = { id: 2, ownerId: 2, team: "soba", position: { x: 3000, y: 0, z: 0 } };
    run(mode, [carrier, watcher], 1);
    const planting = { ...carrier, position: { x: 0, y: 0, z: 0 }, speed: 10 };
    run(mode, [planting, watcher], 4 * 125 + 20, 1);
    expect(mode.bombState.phase).toBe("armed");

    const [defuse] = mode.getAgentDirectives(directiveContext({ teamId: "soba" }), fakeState([]));
    const others = mode.getAgentDirectives(directiveContext({ teamId: "udon" }), fakeState([]));
    expect(defuse.id).toBe("snd_defuse");
    for (const other of others) expect(defuse.priority).toBeGreaterThan(other.priority);
  });

  it("uses ids stable across snapshots, so goal commitment survives", () => {
    const mode = loaded();
    const first = mode.getAgentDirectives(directiveContext({ teamId: "soba" }), fakeState([]));
    const second = mode.getAgentDirectives(directiveContext({ teamId: "soba", tick: 2000 }), fakeState([]));
    expect(first.map((d) => d.id)).toEqual(second.map((d) => d.id));
    // ...but the expiry does move, or they would go stale.
    expect(second[0].expiresAtTick).toBeGreaterThan(first[0].expiresAtTick);
  });
});

// ── Loadouts ─────────────────────────────────────────────────────────

describe("loadouts", () => {
  const PLAYER = 7 as never;

  it("gives an unchosen player the default kit", () => {
    const kit = new SearchAndDestroy().getSpawnLoadout(PLAYER);
    expect(kit.weapons).toContain("blade");
    expect(kit.weapons).toContain(DEFAULT_LOADOUT.primary);
    expect(kit.armor).toBe(100);
  });

  it("does not change the kit a player already has this round", () => {
    // The rule that makes this safe: re-kitting mid-round would turn a lost
    // gunfight into a free retry.
    const mode = loaded();
    mode.setPlayerLoadout(PLAYER, { primary: "electrobolt", secondary: "riotgun" });
    expect(mode.getSpawnLoadout(PLAYER).weapons).not.toContain("electrobolt");
  });

  it("applies it at the start of the next round", () => {
    const mode = loaded();
    mode.setPlayerLoadout(PLAYER, { primary: "electrobolt", secondary: "riotgun" });
    startRound(mode, 2, "udon");
    expect(mode.getSpawnLoadout(PLAYER).weapons).toEqual(["blade", "electrobolt", "riotgun"]);
  });

  it("keeps it for every round after, until it is changed again", () => {
    const mode = loaded();
    mode.setPlayerLoadout(PLAYER, { primary: "voltaic", secondary: "glauncher" });
    startRound(mode, 2, "udon");
    startRound(mode, 3, "udon");
    expect(mode.getSpawnLoadout(PLAYER).weapons).toContain("voltaic");
  });

  it("reports the pending choice, so the HUD can confirm it immediately", () => {
    const mode = loaded();
    mode.setPlayerLoadout(PLAYER, { primary: "electrobolt", secondary: "plasmagun" });
    expect(mode.getPendingLoadout(PLAYER)).toEqual({ primary: "electrobolt", secondary: "plasmagun" });
  });

  it("takes the last choice when a player changes their mind twice", () => {
    const mode = loaded();
    mode.setPlayerLoadout(PLAYER, { primary: "electrobolt", secondary: "riotgun" });
    mode.setPlayerLoadout(PLAYER, { primary: "rlauncher", secondary: "plasmagun" });
    startRound(mode, 2, "udon");
    expect(mode.getSpawnLoadout(PLAYER).weapons).toEqual(["blade", "rlauncher", "plasmagun"]);
  });
});

describe("item rules", () => {
  it("restores the map per round rather than on item timers", () => {
    expect(new SearchAndDestroy().getItemSpawnRules().respawnMode).toBe("round");
  });
});

// ── What the client is told ──────────────────────────────────────────

describe("objective snapshot", () => {
  it("reports nothing in modes without an objective", () => {
    // The default, so a mode that never opts in costs the wire nothing.
    expect(new Deathmatch().getObjectiveState()).toBeNull();
    expect(new Deathmatch().getRoundState()).toBeNull();
  });

  it("carries the bomb's position and the sites the HUD needs", () => {
    const mode = loaded();
    const objective = mode.getObjectiveState();
    expect(objective.kind).toBe("bomb");
    expect(objective.phase).toBe("dropped");
    expect(objective.x).toBeCloseTo(UDON_SPAWNS[0].x, 0);
    expect(objective.sites.map((s) => s.label).sort()).toEqual(["A", "B"]);
  });

  it("addresses the carrier by the key the snapshot uses, not the raw id", () => {
    // A raw entity id would not match anything the client can look up.
    const mode = loaded();
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: UDON_SPAWNS[0] };
    run(mode, [carrier], 1);
    expect(mode.getObjectiveState().carrier).toBe("player_1");
  });

  it("reports the fuse in seconds, not ticks", () => {
    // The client has no tick rate to divide by; a HUD that needs one breaks
    // the day the rate changes.
    const { mode } = armedFixture();
    const objective = mode.getObjectiveState();
    expect(objective.fuse).toBeGreaterThan(25);
    expect(objective.fuse).toBeLessThanOrEqual(30);
    expect(objective.beepInterval).toBeGreaterThan(0);
    expect(objective.beepInterval).toBeLessThan(5.01);
  });

  it("has no fuse before the bomb is armed", () => {
    const mode = loaded();
    expect(mode.getObjectiveState().fuse).toBeNull();
    expect(mode.getObjectiveState().beepInterval).toBeNull();
  });

  it("flips the round state at the arm, which is when the roles invert", () => {
    const mode = loaded();
    expect(mode.getRoundState()).toBe("pre_plant");
    expect(armedFixture().mode.getRoundState()).toBe("post_plant");
  });
});

/** Shared with the round-outcome suite: a bomb planted and armed at site A. */
function armedFixture(): { mode: SearchAndDestroy; armedAt: number } {
  const mode = loaded();
  const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: UDON_SPAWNS[0] };
  const watcher: FakePlayer = { id: 2, ownerId: 2, team: "soba", position: { x: 3000, y: 0, z: 0 } };
  run(mode, [carrier, watcher], 1);
  const planting = { ...carrier, position: { x: 0, y: 0, z: 0 }, speed: 10 };
  run(mode, [planting, watcher], 1, 1);
  const armTicks = 4 * 125 + 10;
  run(mode, [planting, watcher], armTicks, 2);
  expect(mode.bombState.phase).toBe("armed");
  return { mode, armedAt: 2 + armTicks };
}
