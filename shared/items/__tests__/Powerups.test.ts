/**
 * Powerup rules: expiry as an absolute tick, the extend-on-retake grant, the
 * quad damage multiplier, and the snapshot bitmask round-trip.
 */

import { describe, expect, it } from "vitest";
import {
  grantedExpiryTick,
  isPowerupActive,
  maskHasPowerup,
  POWERUP_DURATION_SECONDS,
  type PowerupExpiry,
  packPowerupMask,
  powerupDamageMultiplier,
  powerupSecondsRemaining,
  QUAD_MULTIPLIER,
} from "../Powerups";

const TICK_RATE = 125;
const QUAD_TICKS = POWERUP_DURATION_SECONDS.quad * TICK_RATE;

describe("isPowerupActive", () => {
  it("is inactive when never held, active before expiry, inactive at and after it", () => {
    expect(isPowerupActive({}, "quad", 100)).toBe(false);
    expect(isPowerupActive({ quad: 500 }, "quad", 499)).toBe(true);
    // Expiry is exclusive: at exactly the expiry tick the powerup is gone.
    expect(isPowerupActive({ quad: 500 }, "quad", 500)).toBe(false);
    expect(isPowerupActive({ quad: 500 }, "quad", 501)).toBe(false);
  });
});

describe("grantedExpiryTick", () => {
  it("grants a full duration from now when not already held", () => {
    expect(grantedExpiryTick({}, "quad", 1000, TICK_RATE)).toBe(1000 + QUAD_TICKS);
  });

  it("EXTENDS rather than resets when re-taken while still active", () => {
    // 10s into a 30s quad there are 20s left; re-taking adds a FULL duration on
    // top of the remainder, so 50s — not a reset back to 30s.
    const expiry: PowerupExpiry = { quad: 1000 + QUAD_TICKS };
    const at = 1000 + 10 * TICK_RATE;
    const extended = grantedExpiryTick(expiry, "quad", at, TICK_RATE);
    expect(extended).toBe(1000 + QUAD_TICKS + QUAD_TICKS);
    expect(powerupSecondsRemaining({ quad: extended }, "quad", at, TICK_RATE)).toBeCloseTo(50, 5);
  });

  it("restarts from now when the previous one already lapsed", () => {
    const expired: PowerupExpiry = { quad: 500 };
    expect(grantedExpiryTick(expired, "quad", 9000, TICK_RATE)).toBe(9000 + QUAD_TICKS);
  });
});

describe("powerupSecondsRemaining", () => {
  it("counts down and clamps at zero", () => {
    const expiry: PowerupExpiry = { quad: 1000 + QUAD_TICKS };
    expect(powerupSecondsRemaining(expiry, "quad", 1000, TICK_RATE)).toBeCloseTo(30, 5);
    expect(powerupSecondsRemaining(expiry, "quad", 1000 + QUAD_TICKS / 2, TICK_RATE)).toBeCloseTo(15, 5);
    expect(powerupSecondsRemaining(expiry, "quad", 1000 + QUAD_TICKS, TICK_RATE)).toBe(0);
    expect(powerupSecondsRemaining(expiry, "quad", 999999, TICK_RATE)).toBe(0);
    expect(powerupSecondsRemaining({}, "quad", 0, TICK_RATE)).toBe(0);
  });
});

describe("powerupDamageMultiplier", () => {
  it("is 1x with no component, no quad, or an expired quad", () => {
    expect(powerupDamageMultiplier(undefined, 100)).toBe(1);
    expect(powerupDamageMultiplier({}, 100)).toBe(1);
    expect(powerupDamageMultiplier({ quad: 50 }, 100)).toBe(1);
  });

  it("is 4x while quad is held", () => {
    expect(powerupDamageMultiplier({ quad: 500 }, 100)).toBe(QUAD_MULTIPLIER);
    expect(QUAD_MULTIPLIER).toBe(4);
  });
});

describe("packPowerupMask", () => {
  it("packs only ACTIVE powerups, so a stale expiry can never read as held", () => {
    expect(packPowerupMask({}, 100)).toBe(0);
    expect(packPowerupMask({ quad: 500 }, 100)).not.toBe(0);
    // Same expiry, later tick: the bit must clear on its own.
    expect(packPowerupMask({ quad: 500 }, 600)).toBe(0);
  });

  it("round-trips through maskHasPowerup", () => {
    const held = packPowerupMask({ quad: 500 }, 100);
    expect(maskHasPowerup(held, "quad")).toBe(true);
    expect(maskHasPowerup(0, "quad")).toBe(false);
  });

  it("fits in the single byte the snapshot allocates", () => {
    const all = packPowerupMask({ quad: Number.MAX_SAFE_INTEGER }, 0);
    expect(all).toBeGreaterThan(0);
    expect(all).toBeLessThanOrEqual(0xff);
  });
});
