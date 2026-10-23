import { describe, expect, it } from "vitest";
import type { BotInput } from "../BotBrain";
import { BotGameState } from "../BotGameState";
import {
  type BotSequence,
  type BotSequenceContext,
  BotSequenceRegistry,
  BotSequenceRuntime,
  type BotSequenceState,
} from "../BotSequence";

function input(): BotInput {
  return {
    direction: { x: 0, y: 0, z: 1 },
    pitch: 0,
    yaw: 0,
    buttons: 0,
    weaponSlot: 0,
  };
}

function context(tick: number): BotSequenceContext {
  const state = new BotGameState();
  state.tick = tick;
  return { state };
}

function sequence(
  id: string,
  score: number,
  options: {
    maxTicks?: number;
    commitForTicks?: number;
    terminalStatus?: "running" | "succeeded" | "failed";
    onAbort?: (reason: string) => void;
  } = {},
): BotSequence {
  return {
    id,
    tags: ["test"],
    maxTicks: options.maxTicks ?? 20,
    score: () => score,
    start: (ctx) => ({
      phase: "start",
      startedTick: ctx.state.tick,
      phaseStartedTick: ctx.state.tick,
      commitUntilTick: ctx.state.tick,
      data: {},
    }),
    tick: (_ctx: BotSequenceContext, _state: BotSequenceState) => ({
      input: input(),
      status: options.terminalStatus ?? "running",
      phase: "execute",
      commitForTicks: options.commitForTicks,
    }),
    abort: (_ctx, _state, reason) => options.onAbort?.(reason),
  };
}

describe("BotSequenceRuntime", () => {
  it("selects candidates deterministically by score and id", () => {
    const registry = new BotSequenceRegistry();
    registry.register(sequence("z_equal", 10));
    registry.register(sequence("low", 5));
    registry.register(sequence("a_equal", 10));
    const runtime = new BotSequenceRuntime(registry);

    expect(runtime.startBest(context(100))).toBe(true);
    expect(runtime.activeSequenceId).toBe("a_equal");
  });

  it("refuses ordinary interruption during a committed tick window", () => {
    let abortReason: string | null = null;
    const registry = new BotSequenceRegistry();
    registry.register(
      sequence("committed", 10, {
        commitForTicks: 5,
        onAbort: (reason) => {
          abortReason = reason;
        },
      }),
    );
    const runtime = new BotSequenceRuntime(registry);

    runtime.startBest(context(100));
    runtime.tick(context(100));

    expect(runtime.isCommitted(104)).toBe(true);
    expect(runtime.interrupt(context(104), "enemy_visible")).toBe(false);
    expect(runtime.interrupt(context(105), "enemy_visible")).toBe(true);
    expect(abortReason).toBe("enemy_visible");
  });

  it("uses authoritative ticks for timeout and clears the active sequence", () => {
    const registry = new BotSequenceRegistry();
    registry.register(sequence("short", 1, { maxTicks: 2 }));
    const runtime = new BotSequenceRuntime(registry);

    runtime.startBest(context(40));
    expect(runtime.tick(context(41))?.status).toBe("running");
    expect(runtime.tick(context(42))).toMatchObject({
      sequenceId: "short",
      status: "failed",
      reason: "timeout",
    });
    expect(runtime.isActive).toBe(false);
  });

  it("retains a terminal result after successful completion", () => {
    const registry = new BotSequenceRegistry();
    registry.register(sequence("one_shot", 1, { terminalStatus: "succeeded" }));
    const runtime = new BotSequenceRuntime(registry);

    runtime.startBest(context(7));
    expect(runtime.tick(context(7))?.status).toBe("succeeded");
    expect(runtime.isActive).toBe(false);
    expect(runtime.terminalResult).toMatchObject({ sequenceId: "one_shot", phase: "execute" });
  });
});
