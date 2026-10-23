/**
 * What the network is fed: one builder, one stack, one gap rule, for training
 * and for play alike.
 *
 * TF-11 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BotGameState, type VisiblePlayer } from "../BotGameState";
import { TACTICAL_INPUT_SIZE } from "../BotInputNormalizer";
import type { BotVision } from "../BotVision";
import { buildModelInputs, FeatureHistory, MAX_FRAME_GAP_TICKS, selectCombatTarget } from "../ModelInputs";
import { buildCorpus } from "../TrainingCorpus";
import { demoTempDir, recordPlainMatch } from "./fixtures/scriptedDemo";

describe("FeatureHistory", () => {
  it("stacks oldest first and keeps only the newest few", () => {
    const history = new FeatureHistory(3);
    history.push([1], 10);
    history.push([2], 12);
    history.push([3], 14);
    history.push([4], 16);
    expect(history.stacked()).toEqual([2, 3, 4]);
  });

  it("stands the oldest frame in for the ones it does not have yet", () => {
    const history = new FeatureHistory(3);
    history.push([7, 8], 10);
    expect(history.stacked()).toEqual([7, 8, 7, 8, 7, 8]);
    history.push([9, 9], 12);
    expect(history.stacked()).toEqual([7, 8, 7, 8, 9, 9]);
  });

  it("starts over when a frame does not follow the last one", () => {
    const history = new FeatureHistory(3);
    history.push([1], 10);
    history.push([2], 12);
    // A respawn: nothing from before it may appear in the stack after it
    history.push([5], 12 + MAX_FRAME_GAP_TICKS + 1);
    expect(history.stacked()).toEqual([5, 5, 5]);
  });

  it("treats a tick that goes backwards or repeats as a break too", () => {
    const history = new FeatureHistory(3);
    history.push([1], 10);
    history.push([2], 10);
    expect(history.stacked()).toEqual([2, 2, 2]);
    history.push([3], 8);
    expect(history.stacked()).toEqual([3, 3, 3]);
  });

  it("keeps its own copy, so a caller reusing an array cannot rewrite the past", () => {
    const history = new FeatureHistory(2);
    const reused = [1];
    history.push(reused, 10);
    reused[0] = 99;
    history.push(reused, 12);
    expect(history.stacked()).toEqual([1, 99]);
  });

  it("has nothing to offer before anything was pushed, or after clear", () => {
    const history = new FeatureHistory(3);
    expect(history.stacked()).toEqual([]);
    history.push([1], 10);
    history.clear();
    expect(history.stacked()).toEqual([]);
    expect(history.size).toBe(0);
  });
});

function stateWithEnemies(): BotGameState {
  const state = new BotGameState();
  state.self.position = { x: 0, y: 0, z: 0 };
  const enemy = (id: string, x: number): VisiblePlayer => ({
    entityId: id,
    playerId: id,
    position: { x, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isDead: false,
    team: "",
    relation: "enemy",
    distance: x,
  });
  state.players = [enemy("near", 100), enemy("far", 900)];
  return state;
}

describe("selectCombatTarget", () => {
  it("prefers the enemy in line of sight over a nearer one behind a wall", () => {
    const state = stateWithEnemies();
    const far = state.players[1];
    const target = selectCombatTarget(state, { visibleEnemies: [{ player: far }] as never });
    expect(target?.entityId).toBe("far");
  });

  it("falls back to the nearest when nothing is in sight, or there is no map", () => {
    const state = stateWithEnemies();
    expect(selectCombatTarget(state, { visibleEnemies: [] })?.entityId).toBe("near");
    expect(selectCombatTarget(state, null)?.entityId).toBe("near");
  });
});

describe("buildModelInputs", () => {
  it("fills the item distances from the map when there is one", () => {
    const state = stateWithEnemies();
    const vision = { findNearestItem: () => ({ x: 300, y: 0, z: 0 }) } as unknown as BotVision;
    const seeing = buildModelInputs(state, vision, null);
    const blind = buildModelInputs(state, null, null);
    // 300 units over the 3000-unit scale
    expect(seeing.tactical[22]).toBeCloseTo(0.1, 5);
    expect(blind.tactical[22]).toBe(1);
    expect(seeing.tactical).toHaveLength(TACTICAL_INPUT_SIZE);
  });

  it("has no combat vector when there is no one to be about", () => {
    const state = new BotGameState();
    expect(buildModelInputs(state, null, null).combat).toBeNull();
  });
});

describe("a corpus read with the map", () => {
  let dir: string;

  beforeAll(async () => {
    dir = demoTempDir("vision");
    await recordPlainMatch(dir, "match-vision", 6);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives every player their own perception, and uses it for every frame", async () => {
    const forks: Array<{ looks: number }> = [];
    const map = {
      fork() {
        const perception = {
          looks: 0,
          getVisibleState() {
            perception.looks++;
            return { visibleEnemies: [] };
          },
          findNearestItem: () => ({ x: 300, y: 0, z: 0 }),
        };
        forks.push(perception);
        return perception;
      },
    } as unknown as BotVision;

    const corpus = await buildCorpus(dir, { includeBots: true, visionFor: async () => map });

    // One fork per player, as the bot server gives one per bot: a shared line of
    // sight cache would answer one player's question with another's view
    expect(forks).toHaveLength(2);
    for (const perception of forks) expect(perception.looks).toBe(6);
    expect(corpus.blindMaps).toEqual([]);

    // And what it saw reached the features
    expect(corpus.train.flat()[0].tacticalInput[22]).toBeCloseTo(0.1, 5);
  });

  it("says which maps it had to read blind", async () => {
    const corpus = await buildCorpus(dir, { visionFor: async () => null });
    expect(corpus.blindMaps).toEqual(["wdm7"]);
  });
});
