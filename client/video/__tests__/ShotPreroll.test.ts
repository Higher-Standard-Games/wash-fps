import { describe, expect, it } from "vitest";
import type { DemoService } from "../../DemoService";
import type { DemoViewer } from "../../DemoViewer";
import { warmShot } from "../ShotPreroll";

function fixture() {
  let tick = 1000,
    speed = 0.4,
    attempts = 0;
  const seeks: number[] = [];
  const viewer = {
    getInfo: () => ({ playheadTick: tick, header: { tickRate: 125 }, state: "playing" }),
    getSpeed: () => speed,
    setSpeed: (next: number) => {
      speed = next;
    },
    seekToTick: (next: number) => {
      tick = next;
      seeks.push(next);
      attempts++;
    },
    play: () => {},
    pause: () => {},
  } as unknown as DemoViewer;
  const service = {
    loadedDemoReader: { readIndex: () => ({ entries: [{ tick: 0 }] }) },
    getUnresolvedPlaybackProjectiles: () => (attempts < 2 ? ["proj_1"] : []),
  } as unknown as DemoService;
  return {
    viewer,
    service,
    seeks,
    tick: () => tick,
    speed: () => speed,
    advance: async (dt: number) => {
      tick += (dt / 1000) * 125 * speed;
    },
  };
}

describe("unrecorded shot lead-in", () => {
  it("reconstructs sequentially, extending the lead-in only for missing projectile state", async () => {
    const f = fixture();
    await warmShot(f.service, f.viewer, new AbortController().signal, f.advance);
    expect(f.seeks).toEqual([750, 0]);
    expect(f.tick()).toBeCloseTo(1000, 5);
    expect(f.speed()).toBe(0.4);
  });

  it("restores playback speed when cancellation interrupts pre-roll", async () => {
    const f = fixture(),
      controller = new AbortController();
    await expect(
      warmShot(f.service, f.viewer, controller.signal, async (dt) => {
        await f.advance(dt);
        controller.abort(new Error("cancel warmup"));
      }),
    ).rejects.toThrow("cancel warmup");
    expect(f.speed()).toBe(0.4);
    expect(f.seeks).toHaveLength(1);
  });
});
