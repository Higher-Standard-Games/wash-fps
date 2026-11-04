import { describe, expect, it } from "vitest";
import { type AimTarget, assistTurn, FRICTION, nearestTarget } from "../AimAssist";

// Looking along +z from the origin, level
const view = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const enemy = (x: number, z: number, y = 0): AimTarget => ({ x, y, z, height: 56 });
const seen = () => true;

describe("aim assist", () => {
  it("finds the target nearest the crosshair that it reaches and can see", () => {
    const ahead = enemy(0, 500);
    const aside = enemy(30, 500);
    expect(nearestTarget(view, [aside, ahead], seen)?.over).toBe(true);
    expect(nearestTarget(view, [enemy(300, 500)], seen)).toBeNull();
    expect(nearestTarget(view, [enemy(0, 2000)], seen)).toBeNull();
    expect(nearestTarget(view, [ahead], () => false)).toBeNull();
    const offset = nearestTarget(view, [aside], seen);
    expect(offset?.over).toBe(false);
    expect(offset?.yaw).toBeGreaterThan(0);
  });

  it("gives a still thumb nothing", () => {
    const offset = nearestTarget(view, [enemy(30, 500)], seen);
    expect(assistTurn(0, 0, offset)).toEqual([0, 0]);
  });

  it("slows turning over a target and bends the turn toward it by at most a quarter", () => {
    const over = nearestTarget(view, [enemy(0, 500)], seen);
    const [slowed] = assistTurn(0.01, 0, over);
    expect(slowed).toBeLessThan(0.01);
    expect(slowed).toBeGreaterThanOrEqual(0.01 * FRICTION - 1e-9);

    const near = nearestTarget(view, [enemy(40, 500)], seen);
    const [toward] = assistTurn(0.004, 0, near);
    expect(toward).toBeGreaterThan(0.004);
    expect(toward).toBeLessThanOrEqual(0.004 * 1.25 + 1e-9);
    const [away] = assistTurn(-0.004, 0, near);
    expect(away).toBeGreaterThan(-0.004);
  });

  it("never pulls past the target", () => {
    const near = nearestTarget(view, [enemy(5, 500)], seen);
    const [turn] = assistTurn(0.2, 0, near);
    expect(turn).toBeLessThanOrEqual(0.2 * FRICTION + Math.abs(near?.yaw ?? 0) + 1e-9);
  });
});
