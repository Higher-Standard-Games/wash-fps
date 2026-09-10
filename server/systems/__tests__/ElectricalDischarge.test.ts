/**
 * Electrical discharge (water Phase 3).
 *
 * Firing an electrical weapon underwater puts the charge into the water. The
 * rule has to be sharp in two directions: it must fire when it should, and it
 * must not electrocute someone standing dry on the poolside just because they
 * were close.
 */

import { describe, expect, it } from "vitest";
import {
  caughtInDischarge,
  DISCHARGE_DAMAGE,
  DISCHARGE_RADIUS,
  DISCHARGING_WEAPONS,
  dischargeDamageAt,
  dischargesInWater,
} from "../ElectricalDischarge";

describe("dischargesInWater", () => {
  it("discharges the electrical weapons when submerged", () => {
    expect(dischargesInWater("electrobolt", 2)).toBe(true);
    expect(dischargesInWater("voltaic", 3)).toBe(true);
  });

  it("does not discharge while merely wading", () => {
    // Wet boots do not complete a circuit; the weapon is still above water.
    expect(dischargesInWater("electrobolt", 1)).toBe(false);
  });

  it("does not discharge on dry land", () => {
    expect(dischargesInWater("voltaic", 0)).toBe(false);
  });

  it("leaves non-electrical weapons alone", () => {
    // The plasmagun throws a bolt rather than conducting a current, and the
    // blade's charged blast is mechanical despite reusing the old blast art.
    for (const weapon of ["rlauncher", "plasmagun", "riotgun", "machinegun", "gl", "blade"]) {
      expect(dischargesInWater(weapon, 3)).toBe(false);
    }
  });

  it("names exactly the two electrical weapons", () => {
    expect([...DISCHARGING_WEAPONS].sort()).toEqual(["electrobolt", "voltaic"]);
  });
});

describe("caughtInDischarge", () => {
  it("catches a swimmer inside the radius", () => {
    expect(caughtInDischarge(2, 100 * 100)).toBe(true);
  });

  it("catches someone merely wading, who is still touching the water", () => {
    // Level 1 is enough to be connected — this is the difference between being
    // in the pool and being beside it.
    expect(caughtInDischarge(1, 100 * 100)).toBe(true);
  });

  it("spares someone dry, however close they stand", () => {
    expect(caughtInDischarge(0, 1)).toBe(false);
  });

  it("spares a swimmer in a different pool across the map", () => {
    const farAway = (DISCHARGE_RADIUS + 1) ** 2;

    expect(caughtInDischarge(3, farAway)).toBe(false);
  });

  it("includes the edge of the radius", () => {
    expect(caughtInDischarge(2, DISCHARGE_RADIUS * DISCHARGE_RADIUS)).toBe(true);
  });
});

describe("dischargeDamageAt", () => {
  it("is at full strength at the centre", () => {
    expect(dischargeDamageAt(0)).toBe(DISCHARGE_DAMAGE);
  });

  it("kills a full-health player at the centre", () => {
    // 100 health plus 100 armor is the most anyone carries out of a spawn.
    expect(dischargeDamageAt(0)).toBeGreaterThan(100);
  });

  it("falls off linearly rather than quadratically", () => {
    // "Further is safer" is the intuition players have about a current in
    // water; an explosion's inverse-square falloff would make one step back
    // feel like a cliff edge.
    const half = dischargeDamageAt(DISCHARGE_RADIUS / 2);

    expect(half).toBeCloseTo(DISCHARGE_DAMAGE / 2, 5);
  });

  it("is nothing at the edge and beyond", () => {
    expect(dischargeDamageAt(DISCHARGE_RADIUS)).toBe(0);
    expect(dischargeDamageAt(DISCHARGE_RADIUS * 2)).toBe(0);
  });

  it("is survivable near the edge", () => {
    // A discharge in a crowded pool should be a disaster, not a guaranteed
    // team wipe — someone at the far side gets to swim away.
    expect(dischargeDamageAt(DISCHARGE_RADIUS * 0.9)).toBeLessThan(50);
  });
});
