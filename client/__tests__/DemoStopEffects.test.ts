// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { getExplosionEffect } from "../../../../engine/weapon/ExplosionEffect";
import { getHitscanEffects } from "../../../../engine/weapon/HitscanEffects";
import { DemoService } from "../DemoService";

/**
 * Stopping a demo takes its tracers, bullet holes and explosions with it. They
 * tick on their own, so they went on into the next demo or game (D10).
 */
afterEach(() => vi.restoreAllMocks());

describe("stopping a demo", () => {
  it("clears the hitscan and explosion effects it left on screen", () => {
    const hitscan = vi.spyOn(getHitscanEffects(), "clear");
    const explosions = vi.spyOn(getExplosionEffect(), "clear");

    DemoService.getInstance().stopAll();

    expect(hitscan).toHaveBeenCalled();
    expect(explosions).toHaveBeenCalled();
  });
});
