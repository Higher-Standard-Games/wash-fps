// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Crosshair } from "../Crosshair";
import { damageNumberColor } from "../DamageNumbers";
import { isHeadHit } from "../HitLocationName";

/**
 * A head hit has to look different from a body hit, or the 25% it earns goes unnoticed:
 * its floating number is orange, and the crosshair holds its flash half as long again.
 */
describe("floating number colour", () => {
  it("is white for an ordinary hit and yellow for a big one", () => {
    expect(damageNumberColor(20)).toBe("#FFFFFF");
    expect(damageNumberColor(49, "body")).toBe("#FFFFFF");
    expect(damageNumberColor(50)).toBe("#FFDD00");
  });

  it("is orange for a head hit, whatever its size", () => {
    const orange = damageNumberColor(11, "head");
    expect(orange).toBe("#FF7A1A");
    expect(damageNumberColor(200, "head")).toBe(orange);
  });

  it("treats a leg hit like a body hit", () => {
    expect(damageNumberColor(20, "legs")).toBe("#FFFFFF");
  });
});

describe("recognising a head hit", () => {
  it("is true only for a head, and false when the server said nothing", () => {
    expect(isHeadHit("head")).toBe(true);
    expect(isHeadHit("body")).toBe(false);
    expect(isHeadHit("legs")).toBe(false);
    expect(isHeadHit(undefined)).toBe(false);
  });
});

describe("crosshair hit flash", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Crosshair.getInstance().dispose();
  });

  /** How long, in ms, the flash lasts after a hit at a frozen clock. */
  function flashLength(hitLocation?: "body" | "head" | "legs"): number {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const crosshair = Crosshair.getInstance();
    crosshair.notifyHit(hitLocation);
    return (crosshair as unknown as { hitFlashUntil: number }).hitFlashUntil - 1000;
  }

  it("lasts 200 ms for a body hit, and the same when no location is given", () => {
    expect(flashLength("body")).toBe(200);
    expect(flashLength()).toBe(200);
  });

  it("lasts 300 ms for a head hit", () => {
    expect(flashLength("head")).toBe(300);
  });
});
