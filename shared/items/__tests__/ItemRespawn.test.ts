import { expect, it } from "vitest";
import { itemRespawnSeconds } from "../ItemRespawn";

it.each(["constructor", "__proto__", "toString", "unknown_powerup"])(
  "uses a finite fallback respawn for the unknown powerup %s",
  (kind) => {
    const seconds = itemRespawnSeconds("powerup", kind);
    expect(seconds).toBe(120);
  },
);

it("preserves the shipped Quad respawn duration", () => {
  expect(itemRespawnSeconds("powerup", "quad")).toBe(120);
});
