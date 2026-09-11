import { describe, expect, it } from "vitest";
import {
  getQuadDamagePulse,
  QUAD_DAMAGE_COLOR,
  QUAD_PLAYER_OUTLINE_MIN,
  QUAD_PLAYER_OUTLINE_RANGE,
  QUAD_VIEW_WEAPON_OUTLINE_MIN,
  QUAD_VIEW_WEAPON_OUTLINE_RANGE,
} from "../QuadDamageVisual";

describe("QuadDamageVisual", () => {
  it("keeps the body and weapon pulse within a strong red/orange range", () => {
    const trough = getQuadDamagePulse(0.5);
    const peak = getQuadDamagePulse(1 / 6);

    expect(trough).toBeCloseTo(0);
    expect(peak).toBeCloseTo(1);
    expect(QUAD_PLAYER_OUTLINE_MIN + QUAD_PLAYER_OUTLINE_RANGE * peak).toBeCloseTo(52);
    expect(QUAD_VIEW_WEAPON_OUTLINE_MIN + QUAD_VIEW_WEAPON_OUTLINE_RANGE * trough).toBeCloseTo(0.24);
    expect(QUAD_VIEW_WEAPON_OUTLINE_MIN + QUAD_VIEW_WEAPON_OUTLINE_RANGE * peak).toBeCloseTo(0.48);
    expect(QUAD_DAMAGE_COLOR.r).toBe(1);
    expect(QUAD_DAMAGE_COLOR.g).toBeGreaterThan(QUAD_DAMAGE_COLOR.b);
  });
});
