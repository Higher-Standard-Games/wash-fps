import { describe, expect, it } from "vitest";
import { DemoAnimationTimeline } from "../DemoAnimationTimeline";

function readyTimeline(): DemoAnimationTimeline {
  const timeline = new DemoAnimationTimeline();
  timeline.setClock(100, 100, 1, false, 1);
  timeline.finishPresentationFrame();
  return timeline;
}

describe("DemoAnimationTimeline", () => {
  it("expires one-shots by recorded ticks", () => {
    const timeline = readyTimeline();
    expect(timeline.start("player_1", "blade_slash", 500, 2)).toBe(true);
    expect(timeline.get("player_1")?.endTick).toBe(150);

    timeline.setClock(149.9, 100, 1, false, 1);
    expect(timeline.get("player_1")?.animation).toBe("blade_slash");
    timeline.setClock(150, 100, 1, false, 1);
    expect(timeline.get("player_1")).toBeNull();
  });

  it("scales and freezes active groups with demo transport", () => {
    const timeline = readyTimeline();
    timeline.start("player_1", "blade_slash", 1000, 2);

    timeline.setClock(110, 100, 4, false, 1);
    expect(timeline.get("player_1")?.timeScale).toBe(4);
    timeline.setClock(110, 100, 4, true, 1);
    expect(timeline.get("player_1")?.timeScale).toBe(0);
    timeline.setClock(110, 100, 0.25, false, 1);
    expect(timeline.get("player_1")?.timeScale).toBe(0.25);
  });

  it("clears active state and suppresses landing-frame starts on discontinuity", () => {
    const timeline = readyTimeline();
    timeline.start("player_1", "blade_slash", 1000, 2);

    expect(timeline.setClock(500, 100, 1, false, 2)).toBe(true);
    expect(timeline.get("player_1")).toBeNull();
    expect(timeline.start("player_1", "blade_slash", 1000, 2)).toBe(false);

    timeline.finishPresentationFrame();
    expect(timeline.start("player_1", "blade_slash", 1000, 2)).toBe(true);
  });

  it("replaces an entity's previous one-shot deterministically", () => {
    const timeline = readyTimeline();
    timeline.start("player_1", "first", 1000, 1);
    timeline.setClock(120, 100, 1, false, 1);
    timeline.start("player_1", "second", 250, 1);

    expect(timeline.get("player_1")).toMatchObject({
      animation: "second",
      endTick: 145,
    });
  });
});
