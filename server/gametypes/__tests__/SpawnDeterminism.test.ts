import type { WorldState } from "@engine/server/core/WorldState";
import { describe, expect, it } from "vitest";
import { rngFrom } from "../../../../../shared/DeterministicRng";
import { FurthestSpawnStrategy, RandomSpawnStrategy } from "../SpawnPointStrategy";

const points = [
  { x: 0, y: 0, z: 0 },
  { x: 100, y: 0, z: 0 },
  { x: 0, y: 0, z: 100 },
  { x: 100, y: 0, z: 100 },
  { x: 50, y: 0, z: 50 },
];

// Minimal WorldState stub — Furthest with no enemies takes the random path.
const emptyState = { allEntities: () => [] } as unknown as WorldState;

describe("Spawn selection determinism (R3b)", () => {
  it("RandomSpawnStrategy picks the same point for the same seed", () => {
    const s = new RandomSpawnStrategy();
    const a = s.choose(points, emptyState, undefined, rngFrom(42, 7, 0));
    const b = s.choose(points, emptyState, undefined, rngFrom(42, 7, 0));
    expect(a).toEqual(b);
  });

  it("RandomSpawnStrategy varies across seeds (not degenerate)", () => {
    const s = new RandomSpawnStrategy();
    const picks = new Set<string>();
    for (let tick = 0; tick < 40; tick++) {
      const p = s.choose(points, emptyState, undefined, rngFrom(tick, 1, 0));
      picks.add(`${p.x},${p.z}`);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it("FurthestSpawnStrategy (no enemies) is deterministic for the same seed", () => {
    const s = new FurthestSpawnStrategy();
    const a = s.choose(points, emptyState, undefined, rngFrom(99, 3, 0));
    const b = s.choose(points, emptyState, undefined, rngFrom(99, 3, 0));
    expect(a).toEqual(b);
  });

  it("falls back to Math.random when no rng passed (non-sim callers still work)", () => {
    const s = new RandomSpawnStrategy();
    const p = s.choose(points, emptyState);
    expect(points).toContainEqual(p);
  });
});
