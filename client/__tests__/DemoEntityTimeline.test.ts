import { describe, expect, it } from "vitest";
import type { EntitySnapshot } from "../../../../engine/network/client/SnapshotBuffer";
import { DemoEntityTimeline } from "../DemoEntityTimeline";

function entity(overrides: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    x: 0,
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
    ...overrides,
  };
}

function frame(id: string, value: EntitySnapshot): Map<string, EntitySnapshot> {
  return new Map([[id, value]]);
}

describe("DemoEntityTimeline", () => {
  it("interpolates from recorded ticks without wall-clock time", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(100, frame("player", entity({ x: 0, vx: 100, crouchViewOffset: 0 })));
    timeline.push(104, frame("player", entity({ x: 40, vx: 300, crouching: true, crouchViewOffset: -24 })));

    const result = timeline.sample("player", 102);
    expect(result?.x).toBe(20);
    expect(result?.vx).toBe(200);
    expect(result?.crouching).toBe(true);
    expect(result?.crouchViewOffset).toBe(-12);
  });

  it("interpolates the view pitch with the rest of the pose", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(100, frame("player", entity({ pitch: -0.4 })));
    timeline.push(104, frame("player", entity({ pitch: 0.4 })));
    expect(timeline.sample("player", 101)?.pitch).toBeCloseTo(-0.2);
    expect(timeline.sample("player", 103)?.pitch).toBeCloseTo(0.2);
  });

  it("uses shortest-path yaw interpolation", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(10, frame("player", entity({ yaw: Math.PI * 0.9 })));
    timeline.push(20, frame("player", entity({ yaw: -Math.PI * 0.9 })));

    expect(Math.abs(timeline.sample("player", 15)?.yaw ?? 0)).toBeCloseTo(Math.PI);
  });

  it("holds the newest recorded state without extrapolation", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(10, frame("player", entity({ x: 100, vx: 500 })));

    expect(timeline.sample("player", 1000)?.x).toBe(100);
  });

  it("snaps across teleport-sized gaps", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(10, frame("player", entity({ x: 0 })));
    timeline.push(20, frame("player", entity({ x: 1000 })));

    expect(timeline.sample("player", 11)?.x).toBe(0);
    expect(timeline.sample("player", 20)?.x).toBe(1000);
  });

  it("supports out-of-order lookahead and keeps the last inserted frame on flush", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(20, frame("player", entity({ x: 20 })));
    timeline.push(10, frame("player", entity({ x: 10 })));
    timeline.flush();

    expect(timeline.getSize()).toBe(1);
    expect(timeline.sample("player", 10)?.x).toBe(10);
  });

  it("reports entity ids from the frame at the playhead", () => {
    const timeline = new DemoEntityTimeline();
    timeline.push(10, frame("old", entity()));
    timeline.push(20, frame("new", entity()));

    expect(timeline.getEntityIds(15)).toEqual(new Set(["old"]));
    expect(timeline.getEntityIds(20)).toEqual(new Set(["new"]));
  });
});
