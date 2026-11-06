/**
 * Armor plate boundaries, health pickup caps and overheal decay.
 */

import { describe, expect, it } from "vitest";
import { armorAfterPickup, decayOverheal, healthAfterPickup } from "../ItemGrants";

describe("armorAfterPickup — plate boundaries", () => {
  it("shard adds a flat +5, capped at 100", () => {
    expect(armorAfterPickup(0, "shard")).toBe(5);
    expect(armorAfterPickup(58, "shard")).toBe(63);
    expect(armorAfterPickup(98, "shard")).toBe(100);
    expect(armorAfterPickup(100, "shard")).toBe(100);
  });

  it("green (1 plate) tops the current partial plate up to its 25-boundary", () => {
    expect(armorAfterPickup(0, "ga")).toBe(25);
    expect(armorAfterPickup(58, "ga")).toBe(75);
    expect(armorAfterPickup(50, "ga")).toBe(75);
    expect(armorAfterPickup(75, "ga")).toBe(100);
    expect(armorAfterPickup(99, "ga")).toBe(100);
  });

  it("yellow inserts 2 plates", () => {
    expect(armorAfterPickup(0, "ya")).toBe(50);
    expect(armorAfterPickup(58, "ya")).toBe(100);
  });

  it("red fills to 100", () => {
    expect(armorAfterPickup(0, "ra")).toBe(100);
    expect(armorAfterPickup(58, "ra")).toBe(100);
  });
});

describe("healthAfterPickup — caps + overheal", () => {
  it("medium/large add and cap at 100", () => {
    expect(healthAfterPickup(50, "medium")).toBe(75); // +25
    expect(healthAfterPickup(90, "medium")).toBe(100); // +25 capped
    expect(healthAfterPickup(60, "large")).toBe(100); // +50 capped
    expect(healthAfterPickup(100, "medium")).toBe(100); // no benefit
  });

  it("small adds +5 and overheals to 200, so it is taken at full health", () => {
    expect(healthAfterPickup(50, "small")).toBe(55);
    expect(healthAfterPickup(97, "small")).toBe(102);
    expect(healthAfterPickup(100, "small")).toBe(105);
    expect(healthAfterPickup(198, "small")).toBe(200);
    expect(healthAfterPickup(200, "small")).toBe(200);
  });

  it("mega/ultra overheal to 200", () => {
    expect(healthAfterPickup(100, "mega")).toBe(200);
    expect(healthAfterPickup(150, "mega")).toBe(200); // +100 capped at 200
    expect(healthAfterPickup(100, "ultra")).toBe(200); // ultra == mega
    expect(healthAfterPickup(200, "mega")).toBe(200);
  });
});

describe("decayOverheal", () => {
  it("bleeds 1 HP toward 100 while overhealed, never below 100", () => {
    expect(decayOverheal(200)).toBe(199);
    expect(decayOverheal(101)).toBe(100);
    expect(decayOverheal(100)).toBe(100); // not overhealed → unchanged
    expect(decayOverheal(80)).toBe(80);
  });

  it("respects a custom rate", () => {
    expect(decayOverheal(200, 5)).toBe(195);
    expect(decayOverheal(102, 5)).toBe(100); // clamps to 100
  });
});
