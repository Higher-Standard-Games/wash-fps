// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CinematicSegment } from "../../../../shared/demo/SequenceBuilder";
import { CinematicHUD } from "../CinematicHUD";

const segment: CinematicSegment = {
  startTick: 100,
  endTick: 200,
  durationMs: 1000,
  cameraPreset: "chase_hero",
  playbackSpeed: 1,
  highlight: {
    startTick: 100,
    peakTick: 150,
    endTick: 200,
    score: 10,
    type: "frag",
    primaryPlayer: "player_1",
    primaryPlayerName: "Alice",
    weaponId: "rocket_launcher",
    tags: ["airborne"],
  },
  isReplay: false,
  segmentIndex: 0,
  transitionIn: "cut",
  transitionOut: "cut",
  transitionDurationMs: 0,
};

describe("CinematicHUD", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("supports visibility, progress, segment presentation, and clean disposal", () => {
    const hud = new CinematicHUD();
    const container = document.querySelector<HTMLElement>("#cinematic-hud");
    expect(container).not.toBeNull();

    hud.hide();
    expect(container?.style.display).toBe("none");
    hud.show();
    expect(container?.style.display).toBe("block");

    hud.showSegmentInfo(segment, 3);
    hud.updateProgress({
      state: "playing",
      currentSegment: 0,
      totalSegments: 3,
      reelElapsedMs: 500,
      reelTotalMs: 1000,
      reelProgress: 0.5,
      currentHighlight: segment.highlight,
      isReplay: false,
      currentSpeed: 1,
    });
    expect(container?.textContent).toContain("Alice");
    expect(container?.textContent).toContain("0:00 / 0:01");

    hud.dispose();
    vi.runAllTimers();
    expect(document.querySelector("#cinematic-hud")).toBeNull();
  });
});
