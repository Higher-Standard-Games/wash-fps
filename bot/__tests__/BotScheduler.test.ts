import { describe, expect, it, vi } from "vitest";
import { BOT_TICK_MS, decisionPhase, scheduleBotTick, scheduledBotCount } from "../BotScheduler";

describe("one timer for every bot", () => {
  it("runs each bot's tick from one timer, and stops when the last bot leaves", () => {
    vi.useFakeTimers();
    try {
      const runs: string[] = [];
      const stopA = scheduleBotTick(() => runs.push("a"));
      const stopB = scheduleBotTick(() => runs.push("b"));
      expect(scheduledBotCount()).toBe(2);
      vi.advanceTimersByTime(BOT_TICK_MS * 2);
      expect(runs).toEqual(["a", "b", "a", "b"]);
      stopA();
      vi.advanceTimersByTime(BOT_TICK_MS);
      expect(runs.slice(4)).toEqual(["b"]);
      stopB();
      expect(scheduledBotCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each new bot its own turn", () => {
    const a = decisionPhase();
    expect(decisionPhase()).toBe(a + 1);
  });
});
