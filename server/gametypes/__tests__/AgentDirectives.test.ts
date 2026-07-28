/**
 * Server side of the directive pipeline: the gametype hook, and TDM's regroup
 * order as the proving case (docs/research/BOT_WEIGHTS_AND_GOALS.md Phase 4).
 *
 * The properties that matter here are the boring ones — a mode that issues no
 * directives must cost nothing, the hook must be pure, and a mode must never be
 * able to address another player.
 */

import { describe, expect, it } from "vitest";
import type { AgentDirectiveContext } from "../../../../../shared/server/gametype";
import { Deathmatch } from "../Deathmatch";
import { TeamDeathmatch } from "../TeamDeathmatch";

// ── Minimal WorldState stand-in ──────────────────────────────────────

interface FakePlayer {
  id: number;
  ownerId: number;
  team: string;
  position: { x: number; y: number; z: number };
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
      })),
  };
}

function context(over: Partial<AgentDirectiveContext> & { players: FakePlayer[] }): AgentDirectiveContext {
  const teams = new Map(over.players.map((p) => [p.ownerId, p.team]));
  return {
    tick: 1000,
    playerId: 1,
    entityId: "p_1",
    teamId: "udon",
    position: { x: 0, y: 0, z: 0 },
    alive: true,
    teamOf: (id: number) => teams.get(id) ?? "",
    ...over,
  };
}

describe("BaseGametype.getAgentDirectives", () => {
  it("defaults to none, so a mode that does not opt in costs nothing", () => {
    const dm = new Deathmatch();
    const players: FakePlayer[] = [{ id: 1, ownerId: 1, team: "", position: { x: 0, y: 0, z: 0 } }];
    expect(dm.getAgentDirectives(context({ players }), fakeState(players) as never)).toHaveLength(0);
  });
});

describe("TeamDeathmatch regroup directive", () => {
  const mates = (x: number): FakePlayer[] => [
    { id: 1, ownerId: 1, team: "udon", position: { x: 0, y: 0, z: 0 } },
    { id: 2, ownerId: 2, team: "udon", position: { x, y: 0, z: 0 } },
    { id: 3, ownerId: 3, team: "udon", position: { x, y: 0, z: 0 } },
  ];

  it("issues a regroup order when the player has drifted from the team", () => {
    const players = mates(3000);
    const out = new TeamDeathmatch().getAgentDirectives(context({ players }), fakeState(players) as never);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("hold_area");
    expect(out[0].target).toMatchObject({ type: "position" });
    // Centre of the two distant teammates, excluding the addressee.
    expect((out[0].target as { position: { x: number } }).position.x).toBeCloseTo(3000, 5);
  });

  it("issues nothing when the player is already with the team", () => {
    const players = mates(200);
    expect(new TeamDeathmatch().getAgentDirectives(context({ players }), fakeState(players) as never)).toHaveLength(0);
  });

  it("issues nothing to a dead or spectating player", () => {
    const players = mates(3000);
    const tdm = new TeamDeathmatch();
    expect(tdm.getAgentDirectives(context({ players, alive: false }), fakeState(players) as never)).toHaveLength(0);
    expect(tdm.getAgentDirectives(context({ players, teamId: "spectator" }), fakeState(players) as never)).toHaveLength(
      0,
    );
  });

  it("ignores the other team when computing the centre", () => {
    const players: FakePlayer[] = [
      { id: 1, ownerId: 1, team: "udon", position: { x: 0, y: 0, z: 0 } },
      { id: 2, ownerId: 2, team: "udon", position: { x: 3000, y: 0, z: 0 } },
      { id: 3, ownerId: 3, team: "soba", position: { x: -9000, y: 0, z: 0 } },
    ];
    const out = new TeamDeathmatch().getAgentDirectives(context({ players }), fakeState(players) as never);
    expect((out[0].target as { position: { x: number } }).position.x).toBeCloseTo(3000, 5);
  });

  it("skips dead teammates", () => {
    const players: FakePlayer[] = [
      { id: 1, ownerId: 1, team: "udon", position: { x: 0, y: 0, z: 0 } },
      { id: 2, ownerId: 2, team: "udon", position: { x: 3000, y: 0, z: 0 } },
      { id: 3, ownerId: 3, team: "udon", position: { x: -9000, y: 0, z: 0 }, dead: true },
    ];
    const out = new TeamDeathmatch().getAgentDirectives(context({ players }), fakeState(players) as never);
    expect((out[0].target as { position: { x: number } }).position.x).toBeCloseTo(3000, 5);
  });

  it("issues nothing to a lone survivor — there is no team to regroup with", () => {
    const players: FakePlayer[] = [{ id: 1, ownerId: 1, team: "udon", position: { x: 0, y: 0, z: 0 } }];
    expect(new TeamDeathmatch().getAgentDirectives(context({ players }), fakeState(players) as never)).toHaveLength(0);
  });

  it("uses an id stable across re-issues, so bot commitment survives", () => {
    const players = mates(3000);
    const tdm = new TeamDeathmatch();
    const a = tdm.getAgentDirectives(context({ players, tick: 1000 }), fakeState(players) as never);
    const b = tdm.getAgentDirectives(context({ players, tick: 1500 }), fakeState(players) as never);
    expect(a[0].id).toBe(b[0].id);
    // …but the expiry must move, or the order would lapse and never return.
    expect(b[0].expiresAtTick).toBeGreaterThan(a[0].expiresAtTick);
  });

  it("sets an expiry ahead of the issuing tick", () => {
    const players = mates(3000);
    const out = new TeamDeathmatch().getAgentDirectives(context({ players, tick: 7777 }), fakeState(players) as never);
    expect(out[0].expiresAtTick).toBeGreaterThan(7777);
  });
});
