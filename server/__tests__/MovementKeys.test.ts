import { describe, expect, it } from "vitest";
import { movementKeys } from "../systems/FPSMovementSubsystem";

/** The wish direction the client builds from its keys, at a yaw. */
function wish(yaw: number, forward: number, strafe: number) {
  const x = Math.sin(yaw) * forward + Math.cos(yaw) * strafe;
  const z = Math.cos(yaw) * forward - Math.sin(yaw) * strafe;
  const length = Math.hypot(x, z) || 1;
  return { forward: z / length, right: x / length };
}

describe("movementKeys", () => {
  it("reads back the keys behind a wish direction at any yaw, diagonals included", () => {
    for (const yaw of [0, 1, -2.5, Math.PI]) {
      for (const [forward, strafe] of [
        [1, 0],
        [0, -1],
        [1, 1],
        [-1, -1],
        [0, 0],
      ] as const) {
        expect(movementKeys(wish(yaw, forward, strafe), yaw)).toEqual({ forward, strafe });
      }
    }
  });
});
