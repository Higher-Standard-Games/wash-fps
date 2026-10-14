// @vitest-environment jsdom

/**
 * A demo's frags and deaths on its timeline: found by reading the recording,
 * placed where a seek would land, and drawn in a lane under the seek bar that
 * seeks to a little before each one when clicked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState } from "../../../../engine/network/core/GameState";
import { DemoRecorder } from "../../server/DemoRecorder";
import { DemoViewer } from "../DemoViewer";
import { DemoViewerHUD } from "../DemoViewerHUD";

function recording(): Uint8Array<ArrayBuffer> {
  const recorder = new DemoRecorder({ map: "wdm2", gametype: "duel", tickRate: 125, snapshotRate: 60 });
  for (let tick = 100; tick <= 1100; tick += 100) {
    const frame = new GameState();
    frame.tick = tick;
    frame.players.set("1", { entityId: "p1", name: "Ramen" } as never);
    frame.players.set("2", { entityId: "p2", name: "Udon" } as never);
    // A frag at 300, and a death nobody caused at 500
    if (tick === 300) frame.events.push({ type: "death", entityId: "p2", killerId: "p1" });
    if (tick === 500) frame.events.push({ type: "death", entityId: "p1", killerId: "p1" });
    recorder.recordFrame(frame);
  }
  return new Uint8Array(Reflect.get(recorder, "_buildDemoBuffer").call(recorder, 10_000));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("demo timeline events", () => {
  it("finds every death in the recording, with who and where on the timeline", async () => {
    const viewer = new DemoViewer();
    await viewer.load(recording());
    const deaths = await viewer.scanDeaths();
    expect(deaths).toEqual([
      { tick: 300, progress: 0.2, victimId: "p2", killerId: "p1", victimName: "Udon", killerName: "Ramen" },
      { tick: 500, progress: 0.4, victimId: "p1", killerId: null, victimName: "Ramen", killerName: null },
    ]);
    expect(viewer.progressOfTick(300 - 125)).toBeCloseTo(0.075);
  });

  it("stops scanning when asked to", async () => {
    const viewer = new DemoViewer();
    await viewer.load(recording());
    const scan = new AbortController();
    scan.abort();
    expect(await viewer.scanDeaths(scan.signal)).toBeNull();
  });

  it("draws a lane of marks under the seek bar that seek when clicked", () => {
    const hud = new DemoViewerHUD();
    const seek = vi.fn();
    hud.onSeek(seek);
    hud.setEvents([
      { progress: 0.2, seekTo: 0.15, kind: "frag", label: "Ramen fragged Udon" },
      { progress: 0.4, seekTo: 0.35, kind: "death", label: "Ramen died" },
      { progress: 0.6, seekTo: 0.55, kind: "other", label: "Udon fragged Soba" },
    ]);
    const marks = [...document.querySelectorAll<HTMLButtonElement>(".dvh-events .dvh-event")];
    expect(marks.map((mark) => mark.className)).toEqual([
      "dvh-event dvh-event--frag",
      "dvh-event dvh-event--death",
      "dvh-event dvh-event--other",
    ]);
    expect(marks[0].style.left).toBe("20%");
    expect(marks[1].getAttribute("aria-label")).toBe("Ramen died");
    marks[0].click();
    expect(seek).toHaveBeenCalledWith(0.15);
    hud.setEvents([]);
    expect(document.querySelectorAll(".dvh-event")).toHaveLength(0);
    hud.dispose();
  });
});
