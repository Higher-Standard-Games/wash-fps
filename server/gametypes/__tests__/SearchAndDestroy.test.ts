/**
 * Search & Destroy: the round rules, and the orders it gives bots.
 *
 * `BombModel` and `MatchState` are tested on their own, so what is exercised
 * here is the wiring nobody else covers — reading the map, placing the bomb for
 * whichever side is attacking this round, and the asymmetric elimination rule
 * that makes an armed bomb outlive its attackers.
 */

import { describe, expect, it } from "vitest";
import type { AgentDirectiveContext, PlayerStats } from "../../../../../shared/server/gametype";
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
/**
 * Where the bomb starts, and therefore where an attacker must be to reach it.
 *
 * Beta's area, always — Warsow's `GT_SelectSpawnPoint` puts the attacking team
 * on `team_CTF_betaspawn` whichever side they are.
 */
const BOMB_SPAWN = SOBA_SPAWNS[0];

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
    credit: () => {},
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

  it("starts the bomb where the attackers spawn, which is beta's area", () => {
    // Warsow's GT_SelectSpawnPoint crosses the sets: attackers use
    // team_CTF_betaspawn whichever team they are. So the bomb sits in beta's
    // area every round, not on the attacking team's own spawns.
    const mode = loaded();
    expect(mode.bombState.position.x).toBeCloseTo(SOBA_SPAWNS[0].x, 0);

    // Second half swaps who attacks; the bomb does not move house.
    startRound(mode, 10, "soba");
    expect(mode.bombState.position.x).toBeCloseTo(SOBA_SPAWNS[0].x, 0);
  });

  it("spawns attackers in beta's area and defenders in alpha's", () => {
    // Reading INITIAL_ATTACKERS alone puts both teams in the wrong half of the
    // map: it names the alpha TEAM as attackers, and Warsow then spawns them on
    // beta's points.
    const mode = loaded(); // udon attacks in round 1
    expect(mode.resolveSpawnTeam("udon")).toBe("soba");
    expect(mode.resolveSpawnTeam("soba")).toBe("udon");

    // After the swap the roles invert, so each side now uses its own set.
    startRound(mode, 10, "soba");
    expect(mode.resolveSpawnTeam("soba")).toBe("soba");
    expect(mode.resolveSpawnTeam("udon")).toBe("udon");
  });

  it("leaves spawns alone before a round has started", () => {
    const mode = new SearchAndDestroy();
    mode.onMapLoad(mapContext());
    expect(mode.resolveSpawnTeam("udon")).toBe("udon");
  });

  it("does not disturb a carried bomb during the round", () => {
    const mode = loaded();
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
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
    const outcome = run(mode, [attacker({ position: BOMB_SPAWN }), defender({ dead: true })], 2);
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
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
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

  it("splits defenders across the sites instead of stacking them", () => {
    // The failure this rules out: every bot runs the same arbitration on the
    // same inputs, so emitting both sites and hoping they choose differently
    // puts the whole team on one of them.
    const mode = loaded();
    const defenders: FakePlayer[] = [
      { id: 10, ownerId: 10, team: "soba", position: { x: 3000, y: 0, z: 0 } },
      { id: 11, ownerId: 11, team: "soba", position: { x: 3010, y: 0, z: 0 } },
      { id: 12, ownerId: 12, team: "soba", position: { x: 3020, y: 0, z: 0 } },
      { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN },
    ];
    run(mode, defenders, 1);

    const sites = defenders
      .filter((d) => d.team === "soba")
      .map((d) => {
        const [directive] = mode.getAgentDirectives(
          directiveContext({ teamId: "soba", entityId: `player_${d.id}` }),
          fakeState(defenders),
        );
        return directive.id;
      });
    // Three defenders, two sites: both covered, and the odd one doubles up.
    expect(new Set(sites).size).toBe(2);
  });

  it("gives the bomb to exactly one attacker and sends the rest to the site", () => {
    // Five bots piling onto the same 64 units of floor is the failure mode.
    const mode = loaded();
    // Outside the 64-unit pickup radius, or it would simply take the bomb.
    const near: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: { x: BOMB_SPAWN.x - 200, y: 0, z: 0 } };
    const far: FakePlayer = { id: 2, ownerId: 2, team: "udon", position: { x: 500, y: 0, z: 0 } };
    const enemy: FakePlayer = { id: 3, ownerId: 3, team: "soba", position: { x: 3000, y: 0, z: 0 } };
    // Nobody is close enough to touch it, so it stays loose for this tick.
    mode.onTick(fakeState([near, far, enemy]), tickContext({ players: [near, far, enemy] }));

    const forNear = mode.getAgentDirectives(directiveContext({ teamId: "udon", entityId: "player_1" }), fakeState([]));
    const forFar = mode.getAgentDirectives(directiveContext({ teamId: "udon", entityId: "player_2" }), fakeState([]));
    expect(forNear[0].id).toBe("snd_fetch_bomb");
    expect(forFar[0].id).toMatch(/^snd_push_site_/);
  });

  it("tells defenders to hunt the carrier, because killing them drops it", () => {
    const mode = loaded();
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
    const defender: FakePlayer = { id: 2, ownerId: 2, team: "soba", position: { x: 3000, y: 0, z: 0 } };
    run(mode, [carrier, defender], 1);
    expect(mode.bombState.carrierId).toBe(1);

    const directives = mode.getAgentDirectives(
      directiveContext({ teamId: "soba", entityId: "player_2" }),
      fakeState([]),
    );
    const hunt = directives.find((d) => d.kind === "hunt");
    expect(hunt?.target).toEqual({ type: "player", entityId: "player_1" });
  });

  it("has exactly one attacker arm the bomb while the others cover", () => {
    const mode = loaded();
    const armer: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
    const mate: FakePlayer = { id: 2, ownerId: 2, team: "udon", position: { x: 900, y: 0, z: 0 } };
    const enemy: FakePlayer = { id: 3, ownerId: 3, team: "soba", position: { x: 3000, y: 0, z: 0 } };
    run(mode, [armer, mate, enemy], 1);
    const planting = { ...armer, position: { x: 0, y: 0, z: 0 }, speed: 10 };
    run(mode, [planting, mate, enemy], 1, 1);
    expect(mode.bombState.phase).toBe("planted");

    const forArmer = mode.getAgentDirectives(directiveContext({ teamId: "udon", entityId: "player_1" }), fakeState([]));
    const forMate = mode.getAgentDirectives(directiveContext({ teamId: "udon", entityId: "player_2" }), fakeState([]));
    expect(forArmer[0].id).toBe("snd_arm");
    expect(forMate[0].id).toBe("snd_cover_plant");
    // Covering must not put them on the bomb — a second body arms no faster.
    expect(forMate[0].target).toMatchObject({ radius: expect.any(Number) });
    expect((forMate[0].target as { radius: number }).radius).toBeGreaterThan(
      (forArmer[0].target as { radius: number }).radius,
    );
  });

  it("ranks a defuse above everything else it ever issues", () => {
    const mode = new SearchAndDestroy();
    mode.onMapLoad(mapContext());
    mode.onTick(fakeState([]), tickContext({ players: [], live: false }));
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
    const watcher: FakePlayer = { id: 2, ownerId: 2, team: "soba", position: { x: 3000, y: 0, z: 0 } };
    run(mode, [carrier, watcher], 1);
    const planting = { ...carrier, position: { x: 0, y: 0, z: 0 }, speed: 10 };
    run(mode, [planting, watcher], 4 * 125 + 20, 1);
    expect(mode.bombState.phase).toBe("armed");

    const [defuse] = mode.getAgentDirectives(directiveContext({ teamId: "soba" }), fakeState([]));
    const others = mode.getAgentDirectives(directiveContext({ teamId: "udon" }), fakeState([]));
    expect(defuse.id).toBe("snd_defuse");
    // And it is the one order a bot should die for — nothing is left to
    // preserve itself for once the bomb is ticking.
    expect(defuse.interrupt).toBe("never");
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

  it("applies a player's FIRST choice at once", () => {
    // They have no kit to re-kit and are not in the round yet. Making them sit
    // out a round to correct a default nobody asked for would be perverse.
    const mode = loaded();
    mode.setPlayerLoadout(PLAYER, { primary: "electrobolt", secondary: "riotgun" });
    expect(mode.getSpawnLoadout(PLAYER).weapons).toEqual(["blade", "electrobolt", "riotgun"]);
    expect(mode.hasChosenLoadout(PLAYER)).toBe(true);
  });

  it("does not change the kit a player already has this round", () => {
    // The rule that makes this safe: re-kitting mid-round would turn a lost
    // gunfight into a free retry.
    const mode = loaded();
    mode.setPlayerLoadout(PLAYER, { primary: "voltaic", secondary: "machinegun" });
    startRound(mode, 2, "udon");

    mode.setPlayerLoadout(PLAYER, { primary: "electrobolt", secondary: "riotgun" });
    expect(mode.getSpawnLoadout(PLAYER).weapons).not.toContain("electrobolt");
    expect(mode.getSpawnLoadout(PLAYER).weapons).toContain("voltaic");
  });

  it("applies a CHANGE at the start of the next round", () => {
    const mode = loaded();
    mode.setPlayerLoadout(PLAYER, { primary: "voltaic", secondary: "machinegun" });
    startRound(mode, 2, "udon");
    mode.setPlayerLoadout(PLAYER, { primary: "electrobolt", secondary: "riotgun" });
    startRound(mode, 3, "udon");
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
    mode.setPlayerLoadout(PLAYER, { primary: "voltaic", secondary: "machinegun" });
    startRound(mode, 2, "udon");
    mode.setPlayerLoadout(PLAYER, { primary: "electrobolt", secondary: "riotgun" });
    mode.setPlayerLoadout(PLAYER, { primary: "rlauncher", secondary: "plasmagun" });
    startRound(mode, 3, "udon");
    expect(mode.getSpawnLoadout(PLAYER).weapons).toEqual(["blade", "rlauncher", "plasmagun"]);
  });

  it("has nobody choosing until they do", () => {
    // What gates the spawn: an unchosen player gets the picker, not a default.
    expect(new SearchAndDestroy().hasChosenLoadout(PLAYER)).toBe(false);
  });
});

describe("item rules", () => {
  it("restores the map per round rather than on item timers", () => {
    expect(new SearchAndDestroy().getItemSpawnRules().respawnMode).toBe("round");
  });

  it("does not spawn Quad", () => {
    // All six bomb maps carry exactly one. In a round with no respawns the
    // usual counterplay — die, come back, wait it out — does not exist, so it
    // is not a prize to contest but a round decided by spawn proximity.
    expect(new SearchAndDestroy().getItemSpawnRules().excludeClassnames).toContain("item_quad");
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
    expect(objective?.kind).toBe("bomb");
    expect(objective?.phase).toBe("dropped");
    expect(objective?.x).toBeCloseTo(BOMB_SPAWN.x, 0);
    expect(objective?.sites.map((s) => s.label).sort()).toEqual(["A", "B"]);
  });

  it("addresses the carrier by the key the snapshot uses, not the raw id", () => {
    // A raw entity id would not match anything the client can look up.
    const mode = loaded();
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
    run(mode, [carrier], 1);
    expect(mode.getObjectiveState()?.carrier).toBe("player_1");
  });

  it("reports the fuse in seconds, not ticks", () => {
    // The client has no tick rate to divide by; a HUD that needs one breaks
    // the day the rate changes.
    const { mode } = armedFixture();
    const objective = mode.getObjectiveState();
    expect(objective?.fuse).toBeGreaterThan(25);
    expect(objective?.fuse).toBeLessThanOrEqual(30);
    expect(objective?.beepInterval).toBeGreaterThan(0);
    expect(objective?.beepInterval).toBeLessThan(5.01);
  });

  it("has no fuse before the bomb is armed", () => {
    const mode = loaded();
    expect(mode.getObjectiveState()?.fuse).toBeNull();
    expect(mode.getObjectiveState()?.beepInterval).toBeNull();
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
  const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
  const watcher: FakePlayer = { id: 2, ownerId: 2, team: "soba", position: { x: 3000, y: 0, z: 0 } };
  run(mode, [carrier, watcher], 1);
  const planting = { ...carrier, position: { x: 0, y: 0, z: 0 }, speed: 10 };
  run(mode, [planting, watcher], 1, 1);
  const armTicks = 4 * 125 + 10;
  run(mode, [planting, watcher], armTicks, 2);
  expect(mode.bombState.phase).toBe("armed");
  return { mode, armedAt: 2 + armTicks };
}

// ── Scoring ──────────────────────────────────────────────────────────

describe("scoring", () => {
  const mode = new SearchAndDestroy();
  const stats = (over: Partial<PlayerStats> = {}): PlayerStats => ({
    frags: 0,
    teamFrags: 0,
    deaths: 0,
    damageGiven: 0,
    teamDamageGiven: 0,
    plants: 0,
    defuses: 0,
    ...over,
  });

  it("pays 1 point per 100 damage", () => {
    expect(mode.scoreFromStats(stats({ damageGiven: 100 }))).toBeCloseTo(1, 5);
    expect(mode.scoreFromStats(stats({ damageGiven: 350 }))).toBeCloseTo(3.5, 5);
  });

  it("values damage over the last shot", () => {
    // The point of the formula: softening three enemies beats stealing a kill.
    const worker = mode.scoreFromStats(stats({ damageGiven: 300 }));
    const thief = mode.scoreFromStats(stats({ frags: 3, damageGiven: 60 }));
    expect(worker).toBeGreaterThan(thief);
  });

  it("penalises team damage twice over", () => {
    expect(mode.scoreFromStats(stats({ damageGiven: 200, teamDamageGiven: 100 }))).toBeCloseTo(0, 5);
    expect(mode.scoreFromStats(stats({ teamDamageGiven: 100 }))).toBeLessThan(0);
  });

  it("costs a teamkill more than an enemy kill earns", () => {
    expect(mode.scoreFromStats(stats({ frags: 1, teamFrags: 1 }))).toBe(0);
    expect(mode.scoreFromStats(stats({ teamFrags: 1 }))).toBeLessThan(0);
  });

  it("pays for the objective, which Warsow defines and never awards", () => {
    expect(mode.scoreFromStats(stats({ plants: 1 }))).toBeGreaterThan(0);
    // A defuse is harder and saves the round, so it is worth more.
    expect(mode.scoreFromStats(stats({ defuses: 1 }))).toBeGreaterThan(mode.scoreFromStats(stats({ plants: 1 })));
  });

  it("keeps the objective worth about a good gunfight, not the whole round", () => {
    // If arming outweighed a strong fighting round, nobody would fight.
    const armed = mode.scoreFromStats(stats({ plants: 1 }));
    const fought = mode.scoreFromStats(stats({ frags: 2, damageGiven: 400 }));
    expect(armed).toBeLessThan(fought);
  });

  it("does nothing for a player who has done nothing", () => {
    expect(mode.scoreFromStats(stats())).toBe(0);
  });
});

// ── The detonation ───────────────────────────────────────────────────

describe("detonation", () => {
  /** A mode whose site A has authored explosion points. */
  function authored(): SearchAndDestroy {
    const mode = new SearchAndDestroy();
    mode.onMapLoad(
      mapContext({
        entities: [
          // Site A points at the group; everything else is the shared fixture.
          entity("misc_capture_area_indicator", { origin: "0 0 0", targetname: "bombsitea0", target: "boom" }),
          ...MAP_ENTITIES.slice(1),
          entity("target_explosion", { targetname: "boom", origin: "10 20 30", delay: "0.5", radius: "450" }),
          entity("target_explosion", { targetname: "boom", origin: "40 50 60", delay: "0.9", radius: "400" }),
        ] as never,
      }),
    );
    startRound(mode, 1, "udon");
    return mode;
  }

  /** Arm the bomb at site A and run the fuse out. */
  function detonate(mode: SearchAndDestroy): void {
    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
    const watcher: FakePlayer = { id: 2, ownerId: 2, team: "soba", position: { x: 3000, y: 0, z: 0 } };
    run(mode, [carrier, watcher], 1);
    const planting = { ...carrier, position: { x: 0, y: 0, z: 0 }, speed: 10 };
    run(mode, [planting, watcher], 1, 1);
    const armTicks = 4 * 125 + 10;
    run(mode, [planting, watcher], armTicks, 2);
    const outcome = run(mode, [planting, watcher], 30 * 125 + 20, 2 + armTicks);
    expect(outcome?.reason).toContain("detonated");
  }

  it("sends nothing until the bomb goes off", () => {
    expect(loaded().getExplosion()).toBeNull();
  });

  it("generates blasts when the mapper authored none", () => {
    // Four of the six shipped bomb maps author nothing at all, so this is the
    // path most detonations actually take.
    const mode = loaded();
    detonate(mode);

    const explosion = mode.getExplosion();
    expect(explosion).not.toBeNull();
    expect(explosion?.points.length).toBeGreaterThan(0);
    for (const point of explosion?.points ?? []) {
      expect(point.delay).toBeGreaterThanOrEqual(0);
      expect(point.delay).toBeLessThanOrEqual(1.5);
      expect(Number.isFinite(point.x)).toBe(true);
    }
  });

  it("uses the mapper's points when there are any", () => {
    // wbomb1 authors 19 and 13; wbomb5 authors 18 on its B site only. Where a
    // mapper placed blasts, the traced fallback must not override them.
    const mode = authored();
    detonate(mode);

    const points = mode.getExplosion()?.points ?? [];
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ x: 10, y: 30, z: 20, radius: 450 });
    expect(points[0].delay).toBeCloseTo(0.5, 5);
  });

  it("is deterministic, so a replayed demo explodes the same way", () => {
    const a = loaded();
    detonate(a);
    const b = loaded();
    detonate(b);
    expect(a.getExplosion()).toEqual(b.getExplosion());
  });

  it("staggers the blasts rather than firing them all at once", () => {
    const mode = loaded();
    detonate(mode);
    const delays = (mode.getExplosion()?.points ?? []).map((p) => p.delay);
    expect(new Set(delays.map((d) => d.toFixed(2))).size).toBeGreaterThan(1);
  });
});

// ── Friendly fire ────────────────────────────────────────────────────

describe("spawn protection", () => {
  it("asks for three seconds of protection from teammates", () => {
    // Friendly fire is ON, and with team spawns and no respawns a mis-timed
    // rocket at the start of a round ends a teammate's whole round before they
    // have moved. Enemy damage is never blocked — they cannot reach a team
    // spawn anyway, and blocking it would be protection from the game.
    expect(new SearchAndDestroy().getMatchConfig().teamSpawnProtection).toBe(3);
  });
});

// ── Warmup ───────────────────────────────────────────────────────────

describe("warmup", () => {
  it("publishes no objective before the first round", () => {
    // BombModel starts life "dropped" at the world origin, so publishing
    // unconditionally put a spinning bomb at 0,0,0 through the whole warmup,
    // with both site markers up and the HUD reading TAKE THE BOMB. Warmup here
    // is the same free-fight duel and FFA get.
    const mode = new SearchAndDestroy();
    mode.onMapLoad(mapContext());
    mode.onTick(fakeState([]), tickContext({ players: [], live: false, round: 0 }));

    expect(mode.getObjectiveState()).toBeNull();
    expect(mode.getRoundState()).toBeNull();
  });

  it("publishes it from round one onward", () => {
    const mode = loaded();
    expect(mode.getObjectiveState()).not.toBeNull();
    expect(mode.getRoundState()).toBe("pre_plant");
  });
});

// ── Plantable ground ─────────────────────────────────────────────────

describe("the ground check", () => {
  /** Collision that reports a flat floor `depth` units below the trace start. */
  function floorAt(depth: number) {
    return {
      trace: (from: { y: number }, to: { y: number }) => {
        const span = from.y - to.y;
        if (span <= 0 || depth > span) return { fraction: 1 };
        return { fraction: depth / span, normal: { x: 0, y: 1, z: 0 } };
      },
    } as never;
  }

  /** Carry the bomb into site A and try to plant, on the given collision. */
  function tryPlant(collision: unknown): string {
    const mode = new SearchAndDestroy();
    mode.onMapLoad(mapContext({ collision: collision as never }));
    startRound(mode, 1, "udon");

    const carrier: FakePlayer = { id: 1, ownerId: 1, team: "udon", position: BOMB_SPAWN };
    const watcher: FakePlayer = { id: 2, ownerId: 2, team: "soba", position: { x: 3000, y: 0, z: 0 } };
    run(mode, [carrier, watcher], 1);
    const planting = { ...carrier, position: { x: 0, y: 0, z: 0 }, speed: 10 };
    run(mode, [planting, watcher], 2, 1);
    return mode.bombState.phase;
  }

  it("reaches the floor from the player's ORIGIN, not from their feet", () => {
    // The origin sits PLAYER_ORIGIN_HEIGHT (24) above the feet. The trace was 8
    // units long, so it stopped short of the ground on every call, reported
    // airborne, and made planting impossible for everybody — the bomb could be
    // carried into a site all round and never go down.
    expect(tryPlant(floorAt(24))).toBe("planted");
  });

  it("still refuses to plant in mid-air", () => {
    // Nothing within reach below: a carrier falling through a site does not get
    // to leave the bomb hanging there.
    expect(tryPlant(floorAt(9999))).toBe("carried");
  });

  it("still refuses a surface too steep to place it on", () => {
    // Warsow excludes ramps deliberately — its own comment notes this removes
    // wbomb1's B ramp as a plant spot. The long trace is the bomb's spawn drop,
    // which must still find flat ground or the bomb never gets picked up.
    const ramp = {
      trace: (from: { y: number }, to: { y: number }) =>
        from.y - to.y > 100
          ? { fraction: 0, normal: { x: 0, y: 1, z: 0 } }
          : { fraction: 0.5, normal: { x: 0.6, y: 0.8, z: 0 } },
    } as never;
    expect(tryPlant(ramp)).toBe("carried");
  });
});
