/**
 * Fighting from the edge of cover: the bot finds the side the enemy cannot
 * see, ducks there after a slow weapon's shot and steps out before the next,
 * ducks between a fast weapon's bursts, and fights in the open without cover.
 */

import { describe, expect, it } from "vitest";
import { BotCoverPeek, type CoverQuery } from "../BotCoverPeek";

// Enemy straight ahead along +z (yaw 0): right of the view is +x. A wall
// hides everything at x <= -60: cover is to the left.
const query = (over: Partial<CoverQuery>): CoverQuery => ({
  tick: 0,
  self: { x: 0, y: 0, z: 0 },
  yaw: 0,
  hidden: (at) => at.x <= -60,
  walkable: () => true,
  refireTicks: 156,
  firedTick: Number.NEGATIVE_INFINITY,
  visible: true,
  ...over,
});

describe("BotCoverPeek", () => {
  it("fights in the open with no cover either side", () => {
    const peek = new BotCoverPeek(1, () => 0.9);
    expect(peek.step(query({ hidden: () => false }))).toBeNull();
  });

  it("ducks to the hidden side after a slow shot and steps out before the next", () => {
    const peek = new BotCoverPeek(1, () => 0.9);
    // Ready to fire, in sight: fights as in the open.
    expect(peek.step(query({ tick: 0 }))).toBeNull();
    // Just fired: into cover (left).
    expect(peek.step(query({ tick: 1, firedTick: 0 }))).toBe(-1);
    // Mid-reload, in cover: stands.
    expect(peek.step(query({ tick: 60, firedTick: 0, visible: false }))).toBe(0);
    // Shortly before the next shot: back out to the right.
    expect(peek.step(query({ tick: 140, firedTick: 0, visible: false }))).toBe(1);
    // Ducked but out of sight, the fight is held.
    expect(peek.holding(140)).toBe(true);
  });

  it("ducks between a fast weapon's bursts", () => {
    const peek = new BotCoverPeek(1, () => 0);
    const moves = new Set<number | null>();
    for (let tick = 0; tick < 250; tick++) moves.add(peek.step(query({ tick, refireTicks: 13 })));
    expect(moves.has(null)).toBe(true);
    expect(moves.has(-1)).toBe(true);
    expect(moves.has(1)).toBe(true);
  });

  it("does not use cover it cannot walk to, nor at a roll above its skill", () => {
    expect(new BotCoverPeek(1, () => 0.9).step(query({ walkable: () => false }))).toBeNull();
    expect(new BotCoverPeek(0.5, () => 0.9).step(query({}))).toBeNull();
  });
});
