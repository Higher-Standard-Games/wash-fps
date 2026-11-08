import { describe, expect, it, vi } from "vitest";
import { ownPresentationClock } from "../../../../engine/core/PresentationTime";
import { WatchedDeathView } from "../WatchedDeathView";

const eye = (yaw: number) => ({ x: 0, y: 60, z: 0, yaw, pitch: 0, effects: null });
const body = { x: 0, y: 0, z: 0 };

describe("the view of a watched player who died", () => {
  it("advances by presentation time, independently of shader waits and repeated draws", () => {
    const clock = { nowMs: 0 };
    const release = ownPresentationClock(clock);
    const now = vi.spyOn(performance, "now");
    try {
      const chase = (wait: number, redraws: number) => {
        const view = new WatchedDeathView();
        clock.nowMs = 0;
        view.pose("p1", eye(0), body, false, null);
        view.pose("p1", null, null, true, null);
        clock.nowMs = 1000 / 60;
        now.mockReturnValue(wait);
        const moved = { x: 100, y: 0, z: 0 };
        const pose = view.pose("p1", null, moved, true, null);
        expect(pose!.x).toBeGreaterThan(0);
        for (let i = 0; i < redraws; i++) {
          now.mockReturnValue(wait + i * 100);
          expect(view.pose("p1", null, moved, true, null)).toEqual(pose);
        }
        return pose;
      };
      expect(chase(10, 0)).toEqual(chase(10000, 5));
    } finally {
      now.mockRestore();
      release();
    }
  });

  it("is their eyes while they live", () => {
    const view = new WatchedDeathView();
    expect(view.pose("p1", eye(0), body, false, null)).toEqual(eye(0));
  });

  it("chases the body from behind and above once they die, though the dead have no sample", () => {
    const view = new WatchedDeathView();
    // Last seen alive at the origin, facing +Z (yaw 0)
    view.pose("p1", eye(0), body, false, null);
    const dead = view.pose("p1", null, null, true, null);
    expect(dead).not.toBeNull();
    // Behind them (toward -Z), above the body, looking down toward it
    expect(dead!.z).toBeLessThan(-50);
    expect(dead!.y).toBeGreaterThan(50);
    expect(dead!.pitch).toBeGreaterThan(0);
    expect(Math.abs(dead!.yaw)).toBeLessThan(0.01);
    expect(Math.abs(dead!.x)).toBeLessThan(1);
  });

  it("goes back to their eyes when they respawn, and starts afresh for someone else", () => {
    const view = new WatchedDeathView();
    view.pose("p1", eye(0), body, false, null);
    view.pose("p1", null, null, true, null);
    expect(view.pose("p1", eye(1), body, false, null)).toEqual(eye(1));
    // A player never seen alive has no body to chase: the view holds
    expect(view.pose("p2", null, null, true, null)).toBeNull();
  });
});
