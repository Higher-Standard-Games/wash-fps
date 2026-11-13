/**
 * Learning tricks from demos: every command between two samples is replayed,
 * however often the demo sampled positions.
 */

import { describe, expect, it } from "vitest";
import type { DemoFrame } from "../../../../shared/demo/DemoReader";
import { buildTimeline, commandsBetween } from "../RouteLearner";

/** Frames `step` ticks apart, each carrying `step` commands whose yaw counts up. */
function frames(count: number, step: number): DemoFrame[] {
  const out: DemoFrame[] = [];
  let yaw = 0;
  for (let i = 0; i < count; i++) {
    const position = { x: i * 10, y: 0, z: 0 };
    const entity = {
      components: new Map<string, unknown>([
        ["transform", { position }],
        ["velocity", { linear: { x: 0, y: 0, z: 0 }, grounded: true }],
      ]),
    };
    out.push({
      tick: i * step,
      state: { entities: new Map([["player_1", entity]]), players: new Map(), events: [] },
      inputs:
        i === 0
          ? []
          : Array.from({ length: step }, () => ({
              playerId: "1",
              buttons: 0,
              yaw: ++yaw,
              pitch: 0,
              forward: 1,
              right: 0,
              weaponSlot: 0,
              commands: 1,
            })),
    } as unknown as DemoFrame);
  }
  return out;
}

describe("commands between two samples", () => {
  it("replays every tick's command when positions are sampled every tick", () => {
    const timeline = buildTimeline(frames(11, 1), "1");
    expect(commandsBetween(timeline, 0, 10)).toHaveLength(10);
  });

  it("replays every command, not one per sample, when sampled every other tick", () => {
    const timeline = buildTimeline(frames(11, 2), "1");
    const commands = commandsBetween(timeline, 0, 10);
    expect(commands).toHaveLength(20);
    expect(commands.map((c) => c.yaw)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("shifts by a delay and stops at the ends of the recording", () => {
    const timeline = buildTimeline(frames(11, 2), "1");
    expect(commandsBetween(timeline, 0, 10, 1)[0].yaw).toBe(2);
    expect(commandsBetween(timeline, 0, 10, 5)).toHaveLength(15);
  });
});
