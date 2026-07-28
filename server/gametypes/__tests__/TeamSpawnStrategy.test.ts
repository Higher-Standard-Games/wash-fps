/**
 * TeamSpawnStrategy — spawning a player on their OWN side of the map.
 *
 * `choose()` was a TODO that ignored teams entirely and picked at random from
 * the whole pool, and nothing ever called `setTeamPoints`. TDM worked around it
 * by declaring `"furthest"`. S&D cannot: every round spawns both teams, and a
 * defender thrown across the map is a broken round.
 */

import type { WorldState } from "@engine/server/core/WorldState";
import { describe, expect, it } from "vitest";
import { createSpawnStrategy, TeamSpawnStrategy } from "../SpawnPointStrategy";

const STATE = { allEntities: () => [] } as unknown as WorldState;

/** Deterministic RNG so selection is reproducible. */
const fixed = (value: number) => () => value;

const UDON = [
  { x: 0, y: 0, z: 0 },
  { x: 100, y: 0, z: 0 },
];
const SOBA = [
  { x: 5000, y: 0, z: 0 },
  { x: 5100, y: 0, z: 0 },
];
const ALL = [...UDON, ...SOBA];

function strategy(): TeamSpawnStrategy {
  const s = new TeamSpawnStrategy();
  s.setTeamPoints("udon", UDON);
  s.setTeamPoints("soba", SOBA);
  return s;
}

describe("TeamSpawnStrategy", () => {
  it("spawns each team among its own points", () => {
    const s = strategy();
    for (const roll of [0, 0.4, 0.99]) {
      expect(UDON).toContainEqual(s.choose(ALL, STATE, undefined, fixed(roll), "udon"));
      expect(SOBA).toContainEqual(s.choose(ALL, STATE, undefined, fixed(roll), "soba"));
    }
  });

  it("spreads across the team's points rather than always picking one", () => {
    const s = strategy();
    expect(s.choose(ALL, STATE, undefined, fixed(0), "udon")).toEqual(UDON[0]);
    expect(s.choose(ALL, STATE, undefined, fixed(0.99), "udon")).toEqual(UDON[1]);
  });

  it("is deterministic for a given RNG — demo re-simulation depends on it", () => {
    const s = strategy();
    const a = s.choose(ALL, STATE, undefined, fixed(0.7), "soba");
    const b = s.choose(ALL, STATE, undefined, fixed(0.7), "soba");
    expect(a).toEqual(b);
  });

  it("falls back to the untagged pool when the player has no team", () => {
    const s = strategy();
    expect(ALL).toContainEqual(s.choose(ALL, STATE, undefined, fixed(0.5)));
  });

  it("falls back to the untagged pool for a team the map has no points for", () => {
    const s = new TeamSpawnStrategy();
    s.setTeamPoints("udon", UDON);
    // "soba" was never registered — must not strand the player at the origin.
    expect(ALL).toContainEqual(s.choose(ALL, STATE, undefined, fixed(0.5), "soba"));
  });

  it("returns a safe default only when there is genuinely nothing", () => {
    const s = new TeamSpawnStrategy();
    expect(s.choose([], STATE, undefined, fixed(0), "udon")).toEqual({ x: 0, y: 100, z: 0 });
  });

  it("reports whether the map supplied any team points", () => {
    expect(new TeamSpawnStrategy().hasTeamPoints()).toBe(false);
    expect(strategy().hasTeamPoints()).toBe(true);
    const empty = new TeamSpawnStrategy();
    empty.setTeamPoints("udon", []);
    expect(empty.hasTeamPoints()).toBe(false);
  });

  it("returns a copy, so callers cannot mutate the stored points", () => {
    const s = strategy();
    const spawn = s.choose(ALL, STATE, undefined, fixed(0), "udon");
    spawn.x = 99999;
    expect(UDON[0].x).toBe(0);
  });

  it("is what the factory builds for the 'team' strategy type", () => {
    expect(createSpawnStrategy("team")).toBeInstanceOf(TeamSpawnStrategy);
  });
});
