// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { EntitySnapshot } from "../../../../engine/network/client/SnapshotBuffer";
import { DemoEntityTimeline } from "../DemoEntityTimeline";

const { RemotePlayerRenderer } = await import("../RemotePlayerRenderer");

function entity(x: number): EntitySnapshot {
  return {
    x,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
    crouching: false,
    sliding: false,
    wallJumping: false,
  };
}

/** Just the demo-sampling state of a renderer: no scene, no models. */
function sampler(timeline: DemoEntityTimeline, playheadTick: number) {
  const renderer = Object.create(RemotePlayerRenderer.prototype) as InstanceType<typeof RemotePlayerRenderer>;
  Object.assign(renderer, { demoTimeline: timeline, demoPlayheadTick: playheadTick, _demoSampleCache: null });
  return renderer;
}

describe("RemotePlayerRenderer demo sample memo", () => {
  it("never serves a sample taken before the frame's lookahead push after it", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(100, new Map([["player", entity(0)]]));
    const renderer = sampler(timeline, 101);

    // An event presented this frame samples first: only the frame before is in the timeline
    expect(renderer.getDemoEntitySample("player")?.x).toBe(0);
    // The lookahead push of the next frame lands at the same playhead
    timeline.push(102, new Map([["player", entity(20)]]));
    // The camera, sampling after it, gets the interpolated pose, as it would had nothing sampled first
    expect(renderer.getDemoEntitySample("player")?.x).toBe(10);
  });

  it("still serves the memo while nothing has changed", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(100, new Map([["player", entity(0)]]));
    timeline.push(102, new Map([["player", entity(20)]]));
    const renderer = sampler(timeline, 101);
    expect(renderer.getDemoEntitySample("player")).toBe(renderer.getDemoEntitySample("player"));
  });
});
