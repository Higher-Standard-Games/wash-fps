import { describe, expect, it, vi } from "vitest";
import { BotState, travelYaw } from "../BotBrain";
import { InputButtons, resolveDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { BotNavGraph } from "../BotNavGraph";
import type { BotVision, VisionResult } from "../BotVision";
import { StateMachineBrain } from "../StateMachineBrain";

function chase(speed: number) {
  const brain = new StateMachineBrain({ ...resolveDifficulty("hard"), mistakeRate: 0 });
  const state = new BotGameState();
  Object.assign(state.self, {
    health: 100,
    armor: 100,
    isGrounded: true,
    position: { x: 0, y: 24, z: 0 },
    velocity: { x: 0, y: 0, z: speed },
  });
  const graph = new BotNavGraph("pursuit");
  graph.loadStaticData({
    nodes: [
      { id: 0, type: "spawn", position: state.self.position },
      { id: 1, type: "floor", position: { x: 0, y: 0, z: 1400 } },
    ],
    edges: [{ from: 0, to: 1, type: "walk", cost: 1400 }],
  });
  const vision: VisionResult = {
    visibleEnemies: [],
    audibleEnemies: [],
    allKnownEnemies: [],
    pickups: [],
    trackedEnemies: [],
    nearestCover: null,
    tracesPerformed: 0,
    chaseTarget: {
      playerId: "foe",
      entityId: "foe",
      lastSeenPosition: { x: 0, y: 24, z: 1400 },
      lastSeenVelocity: { x: 0, y: 0, z: 0 },
      lastSeenTick: 0,
      predictedPosition: { x: 0, y: 24, z: 1400 },
      confidence: 0.6,
      source: "sound",
      lastDistance: 1400,
    },
  };
  return { brain, state, graph, vision };
}

describe("heard-enemy pursuit movement", () => {
  it("steers away from a wall without jumping repeatedly at it", () => {
    const { brain, state, graph, vision } = chase(0);
    const geometry = {
      isWalkable: () => true,
      collisionWorld: { trace: () => ({ hit: true, fraction: 0.1 }) },
    } as unknown as BotVision;
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      for (const tick of [0, 4, 8, 12]) {
        state.tick = tick;
        const input = brain.decide(state, geometry, vision, graph);
        expect(input.buttons & InputButtons.JUMP).toBe(0);
        expect(input.buttons & InputButtons.SPRINT).not.toBe(0);
        expect(input.buttons & (InputButtons.LEFT | InputButtons.RIGHT)).toBe(0);
        expect(input.direction.z).toBe(1);
      }
    } finally {
      random.mockRestore();
    }
  });

  it("moves along supported upper ground while looking toward a heard opponent below", () => {
    const { brain, state, vision } = chase(0);
    state.matchState.gametypeName = "Duel";
    state.self.position.y = 264;
    const geometry = {
      isWalkable: () => true,
      collisionWorld: {
        trace: (from: { x: number; y: number }, to: { y: number }) => ({
          hit: to.y < from.y && from.x > 50,
          fraction: to.y < from.y && from.x > 50 ? 0.5 : 1,
        }),
      },
    } as unknown as BotVision;
    const input = brain.decide(state, geometry, vision, null);
    expect(brain.getState()).toBe(BotState.CHASE);
    expect(input.direction.z).toBe(1);
    expect(Math.sin(travelYaw(input))).toBeGreaterThan(0.9);
    expect(input.yaw).toBeCloseTo(0);
  });

  it("starts a crouchslide on a clear long chase at slide speed", () => {
    const { brain, state, graph, vision } = chase(420);
    const input = brain.decide(state, null, vision, graph);
    expect(brain.getState()).toBe(BotState.CHASE);
    expect(input.buttons & InputButtons.CROUCH).not.toBe(0);
    expect(brain.getNavigationDebug()).toContain("sequence=route_crouchslide");
  });

  it("uses a strafe-jump hop at running speed when a slide is unavailable", () => {
    const { brain, state, graph, vision } = chase(400);
    (brain as unknown as { _slideCooldownUntilTick: number })._slideCooldownUntilTick = 125;
    const input = brain.decide(state, null, vision, graph);
    expect(brain.getState()).toBe(BotState.CHASE);
    expect(input.buttons & InputButtons.JUMP).not.toBe(0);
    expect(brain.getNavigationDebug()).toContain("sequence=route_strafe_jump");
    state.tick = 8;
    state.self.isGrounded = false;
    const airborne = brain.decide(state, null, vision, graph);
    expect(Math.abs(airborne.direction.x)).toBe(1);
  });

  it.each([0, 100, 280, 399])("runs without an optional hop below running speed (%i ups)", (speed) => {
    const { brain, state, graph, vision } = chase(speed);
    const input = brain.decide(state, null, vision, graph);
    expect(input.buttons & InputButtons.JUMP).toBe(0);
    expect(input.buttons & InputButtons.SPRINT).not.toBe(0);
    expect(input.direction.z).toBe(1);
  });
});
