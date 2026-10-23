import { describe, expect, it } from "vitest";
import { travelYaw } from "../BotBrain";
import { InputButtons, resolveDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { BotNavGraph } from "../BotNavGraph";
import type { BotVision } from "../BotVision";
import { StateMachineBrain } from "../StateMachineBrain";

function setup(type: "walk" | "fall") {
  const brain = new StateMachineBrain({ ...resolveDifficulty("hard"), mistakeRate: 0 });
  const state = new BotGameState();
  Object.assign(state.self, { position: { x: 0, y: 24, z: 0 }, health: 100, armor: 0, isGrounded: true });
  state.matchState.gametypeName = "Duel";
  state.pickupActiveMask = [true];
  const pickup = {
    id: 0,
    type: "armor" as const,
    kind: "ra",
    classname: "item_armor_body",
    position: { x: 0, y: type === "fall" ? -100 : 24, z: 1000 },
  };
  const graph = new BotNavGraph("recovery");
  graph.loadStaticData({
    nodes: [
      { id: 0, type: "spawn", position: { ...state.self.position } },
      { id: 1, type: "item", pickupId: 0, position: pickup.position },
    ],
    edges: [{ from: 0, to: 1, type, cost: 1000 }],
  });
  const vision = {
    mapKnowledge: { pickupPositions: [pickup] },
    isWalkable: () => true,
    probeDrop: () => ({ safe: false, reason: "no_landing" }),
    collisionWorld: {
      trace: (from: { y: number }, to: { y: number }) => ({ hit: to.y < from.y, fraction: to.y < from.y ? 0.5 : 1 }),
    },
  } as unknown as BotVision;
  return { brain, state, graph, vision };
}

describe("navigation recovery", () => {
  it("cancels a motionless ledge grab while backing away", () => {
    const { brain, state, graph, vision } = setup("walk");
    state.self.isGrounded = false;
    state.self.velocity = { x: 0, y: 0, z: 0 };
    brain.decide(state, vision, null, graph);
    state.tick = 251;
    const recovered = brain.decide(state, vision, null, graph);
    expect(recovered.cancelScript).toBe(true);
    expect(recovered.buttons & InputButtons.CROUCH).not.toBe(0);
    expect(Math.cos(travelYaw(recovered))).toBeLessThan(0);
  });

  it("backs away from an unsafe drop instead of sending idle input", () => {
    const { brain, state, graph, vision } = setup("fall");
    const input = brain.decide(state, vision, null, graph);
    expect(input.direction.z).toBe(1);
    expect(Math.cos(travelYaw(input))).toBeLessThan(0);
  });

  it("detects commanded movement without position progress and abandons the failed approach", () => {
    const { brain, state, graph, vision } = setup("walk");
    const first = brain.decide(state, vision, null, graph);
    expect(Math.cos(travelYaw(first))).toBeGreaterThan(0);
    state.tick = 251;
    const recovered = brain.decide(state, vision, null, graph);
    expect(recovered.direction.z).toBe(1);
    expect(Math.cos(travelYaw(recovered))).toBeLessThan(0);
    state.tick = 260;
    expect(brain.decide(state, vision, null, graph).direction.z).toBe(1);
  });
});
