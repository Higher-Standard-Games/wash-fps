import { describe, expect, it } from "vitest";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { MovementInput } from "../../../../engine/network/systems/movement/MovementProfile";
import { MovementProfile } from "../MovementProfile";

function input(direction: { x: number; y: number; z: number }, buttons = InputButtons.RIGHT): MovementInput {
  return {
    direction,
    viewAngles: { pitch: 0, yaw: 0 },
    buttons,
    isPressed: (button: number) => (buttons & button) !== 0,
  };
}

function horizontalSpeed(velocity: { x: number; z: number }): number {
  return Math.hypot(velocity.x, velocity.z);
}

describe("MovementProfile wishspeed authority invariant", () => {
  it("does not let client wish-direction magnitude scale speed", () => {
    const unit = new MovementProfile();
    const oversized = new MovementProfile();
    const position = { x: 0, y: 5000, z: 0 };
    const velocity = { x: 0, y: 0, z: 0 };
    const dt = 1 / 125;

    const unitResult = unit.simulate(position, velocity, input({ x: 1, y: 0, z: 0 }), dt, null);
    const oversizedResult = oversized.simulate(position, velocity, input({ x: 1000, y: 0, z: 0 }), dt, null);

    expect(horizontalSpeed(oversizedResult.velocity)).toBeCloseTo(horizontalSpeed(unitResult.velocity), 6);
    expect(horizontalSpeed(oversizedResult.velocity)).toBeLessThanOrEqual(280);
  });

  it("treats NaN wish direction as no input and keeps state finite", () => {
    const profile = new MovementProfile();
    const result = profile.simulate(
      { x: 0, y: 5000, z: 0 },
      { x: 0, y: 0, z: 0 },
      input({ x: Number.NaN, y: 0, z: 0 }),
      1 / 125,
      null,
    );

    expect(Number.isFinite(result.position.x)).toBe(true);
    expect(Number.isFinite(result.position.y)).toBe(true);
    expect(Number.isFinite(result.position.z)).toBe(true);
    expect(Number.isFinite(result.velocity.x)).toBe(true);
    expect(Number.isFinite(result.velocity.y)).toBe(true);
    expect(Number.isFinite(result.velocity.z)).toBe(true);
    expect(horizontalSpeed(result.velocity)).toBe(0);
  });
});
