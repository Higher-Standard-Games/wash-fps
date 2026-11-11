/**
 * Out of a fight a bot looks down open sight lines rather than at the wall a
 * route corner points to, a missed jump on the way to an item does not make it
 * give up on the item, and a jump it keeps missing is left alone for longer.
 */

import { describe, expect, it } from "vitest";
import { type BotInput, BotState } from "../BotBrain";
import { InputButtons, resolveDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import type { NavStep } from "../BotNavGraph";
import type { BotVision } from "../BotVision";
import { StateMachineBrain } from "../StateMachineBrain";

const DEG = Math.PI / 180;

function brain() {
  return new StateMachineBrain({ ...resolveDifficulty("hard"), mistakeRate: 0 });
}

const running = (yaw = 0): BotInput => ({
  direction: { x: 0, y: 0, z: 1 },
  yaw,
  pitch: 0,
  buttons: InputButtons.FORWARD | InputButtons.SPRINT,
  weaponSlot: 0,
});

/** A room open only toward `openYaw`: every other sight line ends at a wall close by. */
function roomOpenToward(openYaw: number): BotVision {
  return {
    collisionWorld: {
      trace: (from: { x: number; z: number }, to: { x: number; z: number }) => {
        const yaw = Math.atan2(to.x - from.x, to.z - from.z);
        const open = Math.abs(Math.atan2(Math.sin(yaw - openYaw), Math.cos(yaw - openYaw))) < 5 * DEG;
        return open ? { hit: false, fraction: 1 } : { hit: true, fraction: 0.1 };
      },
    },
  } as unknown as BotVision;
}

type Looker = {
  currentState: BotState;
  _lookIntoOpenSpace(state: BotGameState, input: BotInput, vision: BotVision): void;
};

describe("looking round while running", () => {
  it("looks down the open side of a corner while still running the route's way", () => {
    const b = brain() as unknown as Looker;
    b.currentState = BotState.HUNT;
    const state = new BotGameState();
    state.self.position = { x: 0, y: 24, z: 0 };
    const input = running(0);
    b._lookIntoOpenSpace(state, input, roomOpenToward(30 * DEG));
    expect(input.yaw).toBeCloseTo(30 * DEG, 6);
    expect(input.moveYaw).toBe(0);
  });

  it("keeps looking along the run when that is open", () => {
    const b = brain() as unknown as Looker;
    b.currentState = BotState.ITEM_RUN;
    const state = new BotGameState();
    const input = running(0);
    b._lookIntoOpenSpace(state, input, roomOpenToward(0));
    expect(input.yaw).toBe(0);
  });

  it("leaves the view alone while firing, and in a fight", () => {
    const b = brain() as unknown as Looker;
    b.currentState = BotState.HUNT;
    const state = new BotGameState();
    const firing = { ...running(0), buttons: InputButtons.FORWARD | InputButtons.FIRE };
    b._lookIntoOpenSpace(state, firing, roomOpenToward(30 * DEG));
    expect(firing.yaw).toBe(0);
    b.currentState = BotState.CHASE;
    const chasing = running(0);
    b._lookIntoOpenSpace(state, chasing, roomOpenToward(30 * DEG));
    expect(chasing.yaw).toBe(0);
  });
});

const step = {
  type: "jump",
  from: { id: 10, position: { x: 0, y: 0, z: 0 } },
  to: { id: 25, position: { x: 0, y: 0, z: 180 } },
} as unknown as NavStep;

describe("a missed jump on the way to an item", () => {
  type Recovering = {
    currentState: BotState;
    _activeItemGoal: unknown;
    _activeSequenceStep: NavStep | null;
    _blockedPickupIds: Map<number, number>;
    _startRecovery(state: BotGameState, stuck?: boolean): BotInput;
  };

  it("keeps the item worth fetching; only being stuck puts it on cooldown", () => {
    const b = brain() as unknown as Recovering;
    const state = new BotGameState();
    state.tick = 100;
    b.currentState = BotState.ITEM_RUN;
    const goal = { id: "item:pickup:3", kind: "item", pickupId: 3, position: { x: 400, y: 0, z: 0 } };
    b._activeItemGoal = goal;
    b._activeSequenceStep = step;
    b._startRecovery(state);
    expect(b._blockedPickupIds.has(3)).toBe(false);

    b._activeItemGoal = goal;
    b._startRecovery(state, true);
    expect(b._blockedPickupIds.has(3)).toBe(true);
  });

  it("is left out of routes for longer each time it is missed", () => {
    const b = brain() as unknown as {
      _blockedNavEdges: Map<string, number>;
      _cooldownNavStep(step: NavStep, tick: number): void;
    };
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      b._cooldownNavStep(step, 0);
      waits.push([...b._blockedNavEdges.values()][0]);
    }
    expect(waits).toEqual([625, 1250, 2500, 5000, 5000]);
  });
});
