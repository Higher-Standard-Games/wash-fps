import { describe, expect, it } from "vitest";
import { PLAYER_ORIGIN_HEIGHT } from "../../../../../engine/physics/PlayerPhysicsConstants";
import { bodySpeedFactor, scaledHitSphere } from "../HitScale";

describe("hit scale", () => {
  it("leaves a normal player's hit sphere exactly as it was", () => {
    const position = { x: 10, y: 20, z: 30 };
    const sphere = scaledHitSphere(position, 32, 1);
    expect(sphere.center).toBe(position);
    expect(sphere.radius).toBe(32);
  });

  it("scales a boss twice the size about its feet, as it is drawn", () => {
    const sphere = scaledHitSphere({ x: 0, y: 0, z: 0 }, 32, 2);
    expect(sphere.radius).toBe(64);
    // The feet stay put; the centre is twice as far above them
    const feet = -PLAYER_ORIGIN_HEIGHT;
    expect(sphere.center.y - feet).toBe(2 * (0 - feet));
  });

  it("speeds a bigger body up by the square root of its size", () => {
    expect(bodySpeedFactor(1)).toBe(1);
    expect(bodySpeedFactor(2.5)).toBeCloseTo(1.58, 2);
  });
});
