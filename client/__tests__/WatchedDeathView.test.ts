import { describe, expect, it } from "vitest";
import { WatchedDeathView } from "../WatchedDeathView";

const eye = (yaw: number) => ({ x: 0, y: 60, z: 0, yaw, pitch: 0, effects: null });
const body = { x: 0, y: 0, z: 0 };

describe("the view of a watched player who died", () => {
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
