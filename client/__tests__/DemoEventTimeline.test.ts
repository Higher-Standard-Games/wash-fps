import { describe, expect, it } from "vitest";
import { DemoEventTimeline } from "../DemoEventTimeline";

function readyTimeline(): DemoEventTimeline {
  const timeline = new DemoEventTimeline();
  timeline.setClock(100, 100, 0);
  timeline.finishPresentationFrame();
  return timeline;
}

describe("DemoEventTimeline", () => {
  it("expires entries in recorded ticks", () => {
    const timeline = readyTimeline();
    expect(timeline.push("pickup", "ARMOR", 1500)).toBe(true);
    timeline.setClock(249, 100, 0);
    expect(timeline.getEntries()).toHaveLength(1);
    timeline.setClock(250, 100, 0);
    expect(timeline.getEntries()).toHaveLength(0);
  });

  it("does not expire while the playhead is paused", () => {
    const timeline = readyTimeline();
    timeline.push("chat", "player: hello", 8000);
    timeline.setClock(100, 100, 0);
    timeline.setClock(100, 100, 0);
    expect(timeline.getEntries()).toHaveLength(1);
  });

  it("clears old entries and suppresses the seek landing frame", () => {
    const timeline = readyTimeline();
    timeline.push("award", "FIRST BLOOD", 3000);
    expect(timeline.setClock(500, 100, 1)).toBe(true);
    expect(timeline.getEntries()).toHaveLength(0);
    expect(timeline.push("kill", "A -> B", 5000)).toBe(false);
    timeline.finishPresentationFrame();
    expect(timeline.push("kill", "A -> C", 5000)).toBe(true);
  });

  it("falls back to 60 Hz for invalid tick rates", () => {
    const timeline = new DemoEventTimeline();
    timeline.setClock(0, 0, 0);
    timeline.finishPresentationFrame();
    timeline.push("damage", "-10", 1000);
    timeline.setClock(59, 0, 0);
    expect(timeline.getEntries()).toHaveLength(1);
    timeline.setClock(60, 0, 0);
    expect(timeline.getEntries()).toHaveLength(0);
  });
});
