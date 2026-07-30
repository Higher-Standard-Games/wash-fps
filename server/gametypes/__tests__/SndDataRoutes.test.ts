/**
 * Search & Destroy data routes, end to end.
 *
 * Every field here crosses at least three boundaries — gametype to controller,
 * controller to snapshot, snapshot through the wire codec, wire to client — and
 * each one is a place a value can be silently dropped. TypeScript does not
 * catch a field that is simply never assigned, and none of the unit tests
 * either side of a boundary notice when the boundary itself loses something.
 *
 * These run the REAL codec and the REAL client-side state manager, so a
 * regression shows up as a missing value rather than as a passing test.
 */

import { describe, expect, it } from "vitest";
import { BinaryProtocol } from "../../../../../shared/net/BinaryProtocol";
import { GameState } from "../../../../../shared/net/GameState";
import { MatchPhase, type MatchStateSnapshot } from "../../../../../shared/server/gametype";
import { MatchStateManager } from "../../../client/MatchStateManager";
import { MatchState } from "../MatchState";

const SND_CONFIG = {
  warmupTimeout: 0,
  countdownDuration: 10,
  timeLimit: 90,
  scoreLimit: 10,
  postGameDuration: 15,
  respawnDelay: 2,
  selfDamage: 1,
  roundBased: true,
  roundsPerHalf: 9,
  leadRequired: 2,
  roundEndDuration: 5,
};

/** A snapshot carrying nothing but the match state. */
function snapshotWith(snapshot: MatchStateSnapshot): GameState {
  const state = new GameState();
  state.tick = 1;
  state.events = [{ type: "match_state", ...snapshot } as never];
  return state;
}

/** Push a match snapshot through the real wire codec and into the client. */
function roundTrip(snapshot: MatchStateSnapshot): MatchStateManager {
  const decoded = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(snapshotWith(snapshot)));
  const manager = MatchStateManager.getInstance();
  for (const event of decoded.events) manager.processEvent(event);
  return manager;
}

/** A live S&D match, one round in. */
function liveMatch(): MatchState {
  const m = new MatchState("Search & Destroy", SND_CONFIG, true);
  m.addPlayer(1 as never);
  m.addPlayer(2 as never);
  m.setPlayerTeam(1 as never, "udon");
  m.setPlayerTeam(2 as never, "soba");
  m.transition(MatchPhase.Countdown);
  m.transition(MatchPhase.Active);
  return m;
}

// ── MatchState → wire → client ───────────────────────────────────────

describe("round context reaches the client", () => {
  it("carries the round number, which the scoreboard is the only place to see", () => {
    const m = liveMatch();
    const client = roundTrip(m.toSnapshot());
    expect(client.round).toBe(1);
  });

  it("carries who is attacking, which decides half the HUD's wording", () => {
    const m = liveMatch();
    const client = roundTrip(m.toSnapshot());

    expect(client.teamRoles).toEqual({ udon: "attacker", soba: "defender" });
    expect(client.isAttacking("udon")).toBe(true);
    expect(client.isAttacking("soba")).toBe(false);
    // An unassigned player is on neither side, not on the attacking one.
    expect(client.isAttacking(undefined)).toBe(false);
  });

  it("omits round context entirely in modes that have no rounds", () => {
    // A deathmatch client showing "ROUND 0" would be worse than showing none.
    const dm = new MatchState("Deathmatch", { ...SND_CONFIG, roundBased: false }, false);
    dm.addPlayer(1 as never);
    dm.transition(MatchPhase.Active);

    const client = roundTrip(dm.toSnapshot());
    expect(client.round).toBe(0);
    expect(client.teamRoles).toEqual({});
  });

  it("carries the new RoundEnd phase through the codec intact", () => {
    // An enum member added mid-project is exactly what a stale codec drops.
    const m = liveMatch();
    m.endRound("udon", { reason: "detonated" });
    expect(m.phase).toBe(MatchPhase.RoundEnd);

    const client = roundTrip(m.toSnapshot());
    expect(client.phase).toBe(MatchPhase.RoundEnd);
    expect(client.getPhaseName()).toBe("Round Over");
  });
});

// ── Round result ─────────────────────────────────────────────────────

describe("the round result reaches the client", () => {
  it("carries everything the banner and the camera need", () => {
    const m = liveMatch();
    m.endRound("soba", { reason: "defused", focus: { x: 12.5, y: -3, z: 400 } });

    const snapshot = m.toSnapshot();
    snapshot.roundResult = m.roundResult ?? undefined;
    const client = roundTrip(snapshot);

    expect(client.roundResult?.reason).toBe("defused");
    expect(client.roundResult?.winner).toBe("soba");
    expect(client.roundResult?.winnerName).toBeTruthy();
    // The camera focus must survive as numbers, not as a stringified object.
    expect(client.roundResult?.focus).toEqual({ x: 12.5, y: -3, z: 400 });
  });

  it("clears on the client when the server stops sending it", () => {
    // The banner must not outlive the intermission because a later snapshot
    // simply omitted the field.
    const m = liveMatch();
    m.endRound("udon", { reason: "detonated" });
    const withResult = m.toSnapshot();
    withResult.roundResult = m.roundResult ?? undefined;
    roundTrip(withResult);

    const client = roundTrip({ ...m.toSnapshot(), roundResult: undefined });
    expect(client.roundResult).toBeNull();
  });
});

// ── Objective and explosion ──────────────────────────────────────────

describe("the bomb reaches the client", () => {
  const objective = {
    kind: "bomb" as const,
    phase: "armed",
    x: 100.5,
    y: -20,
    z: 3000,
    siteId: 1,
    carrier: "player_7",
    progress: 0.42,
    advancing: false,
    worker: "player_7",
    fuse: 12.75,
    beepInterval: 1.0625,
    sites: [
      { id: 0, label: "A", x: 0, y: 0, z: 0 },
      { id: 1, label: "B", x: 4000, y: 10, z: -50 },
    ],
  };

  it("carries the bomb intact, fractions and all", () => {
    // Everything time-based crosses in SECONDS; rounding any of it to integers
    // would make the fuse jump and the meter stutter.
    const m = liveMatch();
    const client = roundTrip({ ...m.toSnapshot(), objective });

    expect(client.bomb).toEqual(objective);
    expect(client.bomb?.fuse).toBeCloseTo(12.75, 5);
    expect(client.bomb?.progress).toBeCloseTo(0.42, 5);
  });

  it("carries the carrier as the key the snapshot addresses players by", () => {
    // The renderer looks the carrier up to attach the bomb to their spine; a
    // raw entity id would match nothing.
    const m = liveMatch();
    const client = roundTrip({ ...m.toSnapshot(), objective });
    expect(client.bomb?.carrier).toBe("player_7");
  });

  it("carries the sites, so markers can be drawn without the BSP", () => {
    const m = liveMatch();
    const client = roundTrip({ ...m.toSnapshot(), objective });
    expect(client.bomb?.sites.map((s) => s.label)).toEqual(["A", "B"]);
  });

  it("reports no bomb in a mode without one", () => {
    const m = liveMatch();
    const client = roundTrip(m.toSnapshot());
    expect(client.bomb).toBeNull();
    expect(client.objective).toBeNull();
  });

  it("carries a full thirty-point detonation without truncating it", () => {
    // The whole schedule ships in one payload. The JSON is length-prefixed with
    // a uint16, so this also checks the payload stays well inside that.
    const points = Array.from({ length: 30 }, (_, i) => ({
      x: i * 37.5,
      y: 96 + i,
      z: -i * 12.25,
      radius: 300,
      delay: (i % 12) * 0.125,
    }));

    const m = liveMatch();
    const client = roundTrip({ ...m.toSnapshot(), objective, explosion: { points } });

    expect(client.explosion?.points).toHaveLength(30);
    expect(client.explosion?.points[29]).toEqual(points[29]);
  });
});

// ── Bot-facing shape ─────────────────────────────────────────────────

describe("what bots read", () => {
  it("gives a bot everything its weight profile needs", () => {
    // Bots are ordinary clients reading the same broadcast. They need the
    // gametype name, their side's role, and the round state — any one missing
    // silently drops them back to the deathmatch profile.
    const m = liveMatch();
    const snapshot = m.toSnapshot();
    snapshot.roundState = "post_plant";

    const decoded = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(snapshotWith(snapshot)));
    const event = decoded.events.find((e) => e.type === "match_state") as Record<string, unknown>;

    expect(event.gametypeName).toBe("Search & Destroy");
    expect(event.teamRoles).toEqual({ udon: "attacker", soba: "defender" });
    expect(event.roundState).toBe("post_plant");
  });
});
