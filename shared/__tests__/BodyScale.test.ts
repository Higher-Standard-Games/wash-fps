import { describe, expect, it } from "vitest";
import { PLAYER_ORIGIN_HEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { normalBodyHeight, scaledBodyHeight } from "../BodyScale";

describe("body scale", () => {
  it("leaves a normal body as it is", () => {
    expect(scaledBodyHeight(22, 1)).toBe(22);
    expect(normalBodyHeight(22, 1)).toBe(22);
  });

  it("scales a height about the feet, and back", () => {
    // The feet stay where they are
    expect(scaledBodyHeight(-PLAYER_ORIGIN_HEIGHT, 2.5)).toBeCloseTo(-PLAYER_ORIGIN_HEIGHT);
    // An eye 22 above the origin is 46 above the feet: 115 above them on a body 2.5 times as big
    expect(scaledBodyHeight(22, 2.5) + PLAYER_ORIGIN_HEIGHT).toBeCloseTo(115);
    expect(normalBodyHeight(scaledBodyHeight(30, 2.5), 2.5)).toBeCloseTo(30);
  });

  it("puts a normal player's head height low on a boss's body", () => {
    // 30 above the origin is a head on a player, the thighs on a body 2.5 times as big
    expect(normalBodyHeight(30, 2.5)).toBeLessThan(0);
  });
});
