/**
 * Drowning and liquid damage (water Phase 7).
 *
 * Pure rules over a per-player timer, so the whole model is testable without a
 * server. The numbers are Q3's because they are load-bearing for how a map
 * plays: twelve seconds of air is long enough to cross a flooded passage and
 * short enough that a fight underwater has a clock.
 */

import { describe, expect, it } from "vitest";
import {
  AIR_SECONDS,
  airFraction,
  createLiquidEffectState,
  DROWN_DAMAGE_MAX,
  DROWN_DAMAGE_STEP,
  LAVA_DAMAGE_PER_LEVEL,
  type LiquidEffectState,
  SLIME_DAMAGE_PER_LEVEL,
  tickLiquidEffects,
} from "../LiquidWorldEffects";

/** Run `seconds` of ticks at the server rate, summing what came back. */
function run(
  state: LiquidEffectState,
  seconds: number,
  level: 0 | 1 | 2 | 3,
  opts: { lava?: boolean; slime?: boolean } = {},
) {
  const dt = 1 / 125;
  let drown = 0;
  let burn = 0;
  let gasps = 0;

  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const r = tickLiquidEffects(state, level, opts.lava ?? false, opts.slime ?? false, dt);
    drown += r.drownDamage;
    burn += r.burnDamage;
    if (r.startedDrowning) gasps++;
  }

  return { drown, burn, gasps };
}

describe("air", () => {
  it("starts full", () => {
    expect(airFraction(createLiquidEffectState())).toBe(1);
  });

  it("does not run down until the head is under", () => {
    // Level 2 is chin-deep with the eye probe clear: the player can breathe.
    const state = createLiquidEffectState();

    run(state, 30, 2);

    expect(airFraction(state)).toBe(1);
  });

  it("runs down while fully submerged", () => {
    const state = createLiquidEffectState();

    run(state, 6, 3);

    expect(airFraction(state)).toBeGreaterThan(0.4);
    expect(airFraction(state)).toBeLessThan(0.6);
  });

  it("refills the moment the head clears", () => {
    const state = createLiquidEffectState();
    run(state, 8, 3);
    expect(airFraction(state)).toBeLessThan(0.5);

    run(state, 0.1, 2);

    expect(airFraction(state)).toBe(1);
  });

  it("costs nothing on dry land", () => {
    const state = createLiquidEffectState();

    const r = run(state, 30, 0);

    expect(r.drown).toBe(0);
    expect(airFraction(state)).toBe(1);
  });
});

describe("drowning", () => {
  it("does not hurt while there is air", () => {
    const state = createLiquidEffectState();

    const r = run(state, AIR_SECONDS - 1, 3);

    expect(r.drown).toBe(0);
  });

  it("hurts on the tick the air runs out, not a second later", () => {
    // Running out and being hurt should be the same moment; a silent gap has
    // nothing to explain it.
    const state = createLiquidEffectState();

    const r = run(state, AIR_SECONDS + 0.05, 3);

    expect(r.drown).toBe(DROWN_DAMAGE_STEP);
    expect(r.gasps).toBe(1);
  });

  it("escalates rather than settling into a survivable rhythm", () => {
    // Collect the individual hits rather than summing over fixed windows. The
    // escalation boundary does not align with wall-clock seconds, so a window
    // can catch two hits while the next catches one — which says nothing about
    // whether the damage is actually climbing.
    const state = createLiquidEffectState();
    const dt = 1 / 125;
    const hits: number[] = [];

    for (let i = 0; i < Math.round((AIR_SECONDS + 6) / dt); i++) {
      const r = tickLiquidEffects(state, 3, false, false, dt);
      if (r.drownDamage > 0) hits.push(r.drownDamage);
    }

    expect(hits.length).toBeGreaterThan(3);
    expect(hits[0]).toBe(DROWN_DAMAGE_STEP);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]).toBeGreaterThan(hits[i - 1]);
    }
  });

  it("caps the escalation", () => {
    const state = createLiquidEffectState();

    run(state, AIR_SECONDS + 40, 3);
    const late = run(state, 1.01, 3).drown;

    expect(late).toBe(DROWN_DAMAGE_MAX);
  });

  it("kills a full-health player who never surfaces", () => {
    const state = createLiquidEffectState();

    const r = run(state, AIR_SECONDS + 20, 3);

    expect(r.drown).toBeGreaterThan(100);
  });

  it("resets the escalation after a breath", () => {
    const state = createLiquidEffectState();
    run(state, AIR_SECONDS + 5, 3);

    run(state, 0.1, 1); // surfaced
    const afterBreath = run(state, AIR_SECONDS + 0.05, 3).drown;

    expect(afterBreath).toBe(DROWN_DAMAGE_STEP);
  });

  it("gasps once per drowning, not once per tick", () => {
    const state = createLiquidEffectState();

    const r = run(state, AIR_SECONDS + 5, 3);

    expect(r.gasps).toBe(1);
  });
});

describe("lava and slime", () => {
  it("burns immediately on contact", () => {
    // Waiting out an invisible timer before the first burn would make lava
    // feel survivable at exactly the moment it should not.
    const state = createLiquidEffectState();

    const r = run(state, 0.05, 1, { lava: true });

    expect(r.burn).toBe(LAVA_DAMAGE_PER_LEVEL);
  });

  it("scales with depth", () => {
    const shallow = run(createLiquidEffectState(), 0.05, 1, { lava: true }).burn;
    const deep = run(createLiquidEffectState(), 0.05, 3, { lava: true }).burn;

    expect(deep).toBe(shallow * 3);
  });

  it("kills a full-health player in about two seconds of deep lava", () => {
    // What makes lava a wall rather than a shortcut.
    const r = run(createLiquidEffectState(), 2.05, 3, { lava: true });

    expect(r.burn).toBeGreaterThanOrEqual(200);
  });

  it("makes slime survivable where lava is not", () => {
    const lava = run(createLiquidEffectState(), 2.05, 3, { lava: true }).burn;
    const slime = run(createLiquidEffectState(), 2.05, 3, { slime: true }).burn;

    expect(slime).toBeLessThan(lava);
    expect(slime).toBe(SLIME_DAMAGE_PER_LEVEL * 3 * 3);
  });

  it("stacks a brush that is both", () => {
    // Four shipped shaders declare WATER|SLIME together; a brush carrying two
    // hostile bits should be worse than either, not whichever was checked
    // first.
    const r = run(createLiquidEffectState(), 0.05, 2, { lava: true, slime: true });

    expect(r.burn).toBe((LAVA_DAMAGE_PER_LEVEL + SLIME_DAMAGE_PER_LEVEL) * 2);
  });

  it("does not burn in plain water", () => {
    expect(run(createLiquidEffectState(), 5, 3).burn).toBe(0);
  });

  it("stops burning the moment you are out", () => {
    const state = createLiquidEffectState();
    run(state, 1.05, 3, { lava: true });

    expect(run(state, 5, 0).burn).toBe(0);
  });

  it("burns again immediately on re-entry", () => {
    // The timer must not carry across a gap the player can see.
    const state = createLiquidEffectState();
    run(state, 1.05, 3, { lava: true });
    run(state, 0.5, 0);

    expect(run(state, 0.05, 3, { lava: true }).burn).toBe(LAVA_DAMAGE_PER_LEVEL * 3);
  });

  it("drowns AND burns in deep slime", () => {
    // Slime is both a liquid you sink in and one that hurts.
    const r = run(createLiquidEffectState(), AIR_SECONDS + 2, 3, { slime: true });

    expect(r.burn).toBeGreaterThan(0);
    expect(r.drown).toBeGreaterThan(0);
  });
});
