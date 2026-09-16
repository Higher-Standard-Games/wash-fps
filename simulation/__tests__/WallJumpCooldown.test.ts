import { describe, expect, it } from "vitest";
import { WallJump } from "../WallJump";

describe("wall-jump cooldown replay", () => {
  function boost(wall: WallJump, at: number) {
    // Isolate the cooldown recorded by both charged and instant boosts.
    (wall as unknown as { startCooldown(now: number, duration: number): void }).startCooldown(at, 1000);
  }

  it("discards a future boost while preserving an earlier active cooldown", () => {
    const wall = new WallJump();
    boost(wall, 100);
    boost(wall, 1200);
    wall.reset();
    wall.beginStep(1000);
    expect(wall.isOnCooldown(1000)).toBe(true);
    expect(wall.isOnCooldown(1100)).toBe(false);
    // If the old predicted boost no longer occurs, its cooldown stays gone.
    wall.beginStep(1250);
    expect(wall.isOnCooldown(1250)).toBe(false);
  });

  it("allows the same boost step to be re-simulated, then reapplies its cooldown", () => {
    const wall = new WallJump();
    boost(wall, 100);
    for (let i = 0; i < 100; i++) {
      wall.reset();
      wall.beginStep(100);
      expect(wall.isOnCooldown(100)).toBe(false);
      boost(wall, 100);
      wall.beginStep(101);
      expect(wall.isOnCooldown(101)).toBe(true);
    }
  });
});
