import { describe, expect, it } from "vitest";
import type { BotGameState, BotKillEvent } from "../BotGameState";
import type { BotSequenceContext } from "../BotSequence";
import { BotVision, type MapKnowledgeData } from "../BotVision";
import type { LearnedRoute } from "../LearnedRoutes";
import { LearnedRouteSequence } from "../sequences/LearnedRouteSequence";

/** Vision over an open map where enemies standing at a hidden x are behind a wall. */
function openVision(hidden: Set<number>): BotVision {
  const world = {
    trace: (_from: { x: number }, to: { x: number }) =>
      hidden.has(Math.round(to.x)) ? { hit: true, fraction: 0.5 } : { hit: false, fraction: 1 },
  };
  const map = { spawnPoints: [], pickupPositions: [], triggerVolumes: [], mapFingerprint: "", mapName: "t" };
  return new BotVision(world as never, map as MapKnowledgeData, false);
}

const enemy = (id: string, x: number) => ({
  playerId: id,
  entityId: `e_${id}`,
  relation: "enemy",
  isDead: false,
  position: { x, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  distance: x,
});

function stateAt(tick: number, recentKills: BotKillEvent[] = []): BotGameState {
  return {
    tick,
    self: { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
    players: [enemy("a", 300), enemy("b", 500)],
    heardEnemies: [],
    pickups: [],
    lastKnownEnemyPositions: new Map(),
    recentKills,
  } as unknown as BotGameState;
}

describe("chase target", () => {
  it("is forgotten when the enemy is fragged", () => {
    const hidden = new Set([500]);
    const vision = openVision(hidden);
    vision.getVisibleState(stateAt(10));
    hidden.add(300);
    expect(vision.getVisibleState(stateAt(20)).chaseTarget?.playerId).toBe("a");
    const kill = { killerId: "x", victimId: "e_a", weaponId: "rl", tick: 30 };
    expect(vision.getVisibleState(stateAt(30, [kill])).chaseTarget).toBeNull();
  });

  it("stays on the enemy being chased while another is only a little fresher", () => {
    const hidden = new Set([500]);
    const vision = openVision(hidden);
    vision.getVisibleState(stateAt(10)); // a seen
    hidden.add(300);
    expect(vision.getVisibleState(stateAt(20)).chaseTarget?.playerId).toBe("a");
    hidden.delete(500);
    vision.getVisibleState(stateAt(100)); // b seen, 90 ticks after a was
    hidden.add(500);
    expect(vision.getVisibleState(stateAt(110)).chaseTarget?.playerId).toBe("a");
  });

  it("moves on when another enemy is a much fresher lead", () => {
    const hidden = new Set([500]);
    const vision = openVision(hidden);
    vision.getVisibleState(stateAt(10));
    hidden.add(300);
    expect(vision.getVisibleState(stateAt(20)).chaseTarget?.playerId).toBe("a");
    hidden.delete(500);
    vision.getVisibleState(stateAt(300)); // b seen long after a
    hidden.add(500);
    expect(vision.getVisibleState(stateAt(310)).chaseTarget?.playerId).toBe("b");
  });
});

describe("learned route approach", () => {
  const route = {
    id: "r",
    start: { x: 0, y: 0, z: 0 },
    landing: { x: 0, y: 0, z: 500 },
    yaw: Math.PI / 2,
    ticks: 10,
    script: "",
  } as unknown as LearnedRoute;

  const context = (x: number, speed: number) =>
    ({
      state: {
        tick: 5,
        self: {
          position: { x, y: 0, z: 0 },
          velocity: { x: speed, y: 0, z: 0 },
          isGrounded: true,
          yaw: 0,
        },
      },
      learnedRoute: route,
    }) as unknown as BotSequenceContext;

  it("creeps back onto an overshot mark looking the way the route starts", () => {
    const sequence = new LearnedRouteSequence();
    const state = {
      phase: "approach",
      startedTick: 0,
      phaseStartedTick: 0,
      commitUntilTick: 0,
      data: { route, script: [], sentTick: null },
    };
    for (const x of [40, -40]) {
      const tick = sequence.tick(context(x, 0), state);
      expect(tick.phase).toBe("creep");
      expect(tick.input.yaw).toBeCloseTo(Math.PI / 2);
      expect(tick.input.moveYaw).toBeCloseTo(x > 0 ? -Math.PI / 2 : Math.PI / 2);
    }
  });
});
