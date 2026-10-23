import { describe, expect, it } from "vitest";
import { BotGameState } from "../BotGameState";
import { BotNavGraph } from "../BotNavGraph";
import { BotTerritory } from "../BotTerritory";
import type { BotVision } from "../BotVision";

const vision = { canSeeFrom: () => true } as unknown as BotVision;

describe("Duel territory", () => {
  const makeGraph = () => {
    const graph = new BotNavGraph("upper-control");
    graph.loadStaticData({
      nodes: [
        { id: 0, type: "spawn", position: { x: 0, y: 24, z: 0 } },
        { id: 1, type: "floor", position: { x: 0, y: 0, z: 300 } },
        { id: 2, type: "floor", position: { x: 300, y: 240, z: 0 } },
        { id: 3, type: "floor", position: { x: 600, y: 1000, z: 0 } },
      ],
      edges: [
        { from: 0, to: 1, type: "walk", cost: 300 },
        {
          from: 0,
          to: 2,
          type: "teleporter",
          cost: 800,
          trigger: {
            id: 0,
            min: { x: -20, y: 0, z: -20 },
            max: { x: 20, y: 64, z: 20 },
            dest: { x: 300, y: 264, z: 0 },
          },
        },
        { from: 2, to: 0, type: "fall", cost: 300 },
      ],
    });
    return graph;
  };

  it("prefers a reachable upper floor over a closer lower patrol and an unreachable roof", () => {
    const state = new BotGameState();
    state.self.position = { x: 0, y: 24, z: 0 };
    expect(new BotTerritory().choose(state, makeGraph(), vision, {})).toEqual({ x: 300, y: 264, z: 0 });
  });

  it("does not leave the upper floor to pursue a sound below", () => {
    const state = new BotGameState();
    state.self.position = { x: 300, y: 264, z: 0 };
    state.lastKnownEnemyPositions.set("enemy", { position: { x: 0, y: 24, z: 300 }, tick: 0 });
    expect(new BotTerritory().choose(state, makeGraph(), vision, {})).toBeNull();
  });
});
