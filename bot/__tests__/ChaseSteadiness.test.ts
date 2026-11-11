import { describe, expect, it } from "vitest";
import { type BotInput, BotState } from "../BotBrain";
import { resolveDifficulty } from "../BotConfig";
import { BotGameState, type BotKillEvent } from "../BotGameState";
import type { BotSequenceContext } from "../BotSequence";
import { BotVision, type MapKnowledgeData, type VisionResult } from "../BotVision";
import type { LearnedRoute } from "../LearnedRoutes";
import { StateMachineBrain } from "../StateMachineBrain";
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

  const fresh = () => ({
    phase: "approach",
    startedTick: 0,
    phaseStartedTick: 0,
    commitUntilTick: 0,
    data: { route, script: [], sentTick: null, settling: false },
  });
  const pushes = (tick: { input: { direction: { z: number } } }) => tick.input.direction.z !== 0;

  it("stops pushing while the coast would carry it onto the mark", () => {
    const sequence = new LearnedRouteSequence();
    // 20 units off at 60 u/s coasts 3 units: push. 3 off at 70 coasts 4: let it coast.
    expect(pushes(sequence.tick(context(-20, 60), fresh()))).toBe(true);
    expect(pushes(sequence.tick(context(-3, 70), fresh()))).toBe(false);
  });

  it("gives up when it stands under or over the mark, on another floor", () => {
    const below = context(0, 0);
    below.state.self.position.y = -200;
    expect(new LearnedRouteSequence().tick(below, fresh()).status).toBe("failed");
  });

  it("stands still on the mark before judging it, even if it coasts a little past", () => {
    const sequence = new LearnedRouteSequence();
    const state = fresh();
    expect(sequence.tick(context(-4, 60), state).phase).toBe("settle");
    const coasting = sequence.tick(context(12, 30), state);
    expect(coasting.phase).toBe("settle");
    expect(pushes(coasting)).toBe(false);
    expect(sequence.tick(context(12, 0), state).phase).toBe("creep");
  });
});

describe("heard enemy during an item run", () => {
  function hearAt(z: number, armor: number): BotState {
    const brain = new StateMachineBrain({ ...resolveDifficulty("hard"), mistakeRate: 0 });
    const state = new BotGameState();
    Object.assign(state.self, { health: 100, armor, isGrounded: true, position: { x: 0, y: 24, z: 0 } });
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
        lastSeenPosition: { x: 0, y: 24, z },
        lastSeenVelocity: { x: 0, y: 0, z: 0 },
        lastSeenTick: 0,
        predictedPosition: { x: 0, y: 24, z },
        confidence: 0.6,
        source: "sound",
        lastDistance: z,
      },
    };
    brain.decide(state, null, vision, null);
    return brain.getState();
  }

  it("keeps going for the item when the sound is far", () => {
    expect(hearAt(600, 0)).toBe(BotState.ITEM_RUN);
  });

  it("chases a sound close by", () => {
    expect(hearAt(300, 0)).toBe(BotState.CHASE);
  });

  it("chases a far sound when it needs nothing", () => {
    expect(hearAt(1400, 100)).toBe(BotState.CHASE);
  });
});

describe("an item out of reach", () => {
  it("is given up after the bot has stayed beside it for a second without taking it", () => {
    const brain = new StateMachineBrain({ ...resolveDifficulty("hard"), mistakeRate: 0 });
    const state = new BotGameState();
    state.self.position = { x: 0, y: 24, z: 0 };
    const goal = { id: "item:dropped:x", kind: "item", position: { x: 20, y: 120, z: 10 } };
    const internals = brain as unknown as {
      _activeItemGoal: unknown;
      _blockedGoalIds: Map<string, number>;
      _giveUpOnCircledItem(state: BotGameState): void;
    };
    internals._activeItemGoal = goal;
    for (const tick of [100, 160, 220]) {
      state.tick = tick;
      internals._giveUpOnCircledItem(state);
    }
    expect(internals._blockedGoalIds.has(goal.id)).toBe(false);
    state.tick = 230;
    internals._giveUpOnCircledItem(state);
    expect(internals._blockedGoalIds.has(goal.id)).toBe(true);
    expect(internals._activeItemGoal).toBeNull();
  });
});

describe("steering round a wall ahead", () => {
  it("keeps turning the side it chose while the rays see the wall from new angles", () => {
    const brain = new StateMachineBrain({ ...resolveDifficulty("hard"), mistakeRate: 0 });
    const state = new BotGameState();
    state.self.position = { x: 0, y: 24, z: 0 };
    // Wall ahead; the side rays open alternately, as they do while turning.
    let leftOpen = true;
    const vision = {
      collisionWorld: {
        trace: (from: { x: number }, to: { x: number }) => {
          const dx = to.x - from.x;
          if (Math.abs(dx) < 1) return { hit: true, fraction: 0.3 };
          return dx < 0 === leftOpen ? { hit: true, fraction: 0.9 } : { hit: true, fraction: 0.7 };
        },
      },
    } as unknown as BotVision;
    const steer = (
      brain as unknown as { _applyFeelers(i: BotInput, s: BotGameState, v: BotVision): BotInput }
    )._applyFeelers.bind(brain);
    const turns: number[] = [];
    for (const tick of [0, 4, 8, 12]) {
      state.tick = tick;
      leftOpen = !leftOpen;
      const input = steer(
        { direction: { x: 0, y: 0, z: 1 }, yaw: 0, pitch: 0, buttons: 0, weaponSlot: 0 },
        state,
        vision,
      );
      turns.push(Math.sign(input.yaw));
    }
    expect(new Set(turns).size).toBe(1);
  });
});
