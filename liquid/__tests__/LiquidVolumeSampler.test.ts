/**
 * Three-point water sampling (water Phase 1).
 *
 * This is the number every liquid behaviour reads, and the server and the
 * predicted client both compute it from the same pure function. If it can
 * disagree between them, a swimmer jitters; if it can disagree between a step
 * and its replay, reconciliation diverges.
 *
 * Player geometry, for the probe heights below:
 *   standing — hull floor at origin-24, eye at origin+34
 *   crouched — hull floor at origin-4,  eye at origin+12
 */

import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../../../engine/network/components/TransformComponent";
import {
  CROUCH_MINS_Z,
  CROUCH_VIEWHEIGHT,
  DEFAULT_VIEWHEIGHT,
  PLAYER_MINS_Z,
} from "../../../../engine/physics/PlayerPhysicsConstants";
import { Contents } from "../../../../shared/collision/CollisionWorld";
import { fallDamageScale, isSwimming, type LiquidSample, liquidTransitions } from "../LiquidTypes";
import { type PointContentsSource, sampleLiquid } from "../LiquidVolumeSampler";

const STANDING = { minsY: PLAYER_MINS_Z, viewHeight: DEFAULT_VIEWHEIGHT };
const CROUCHED = { minsY: CROUCH_MINS_Z, viewHeight: CROUCH_VIEWHEIGHT };

/** A pool filling everything below `surfaceY`. */
function pool(surfaceY: number, kind: number = Contents.WATER): PointContentsSource {
  return { pointContents: (p: Vec3) => (p.y <= surfaceY ? kind : 0) };
}

const DRY: PointContentsSource = { pointContents: () => 0 };

describe("sampleLiquid — levels", () => {
  it("is dry when the feet are clear", () => {
    // Feet at 76-24 = 52, above a surface at 50.
    const sample = sampleLiquid(pool(50), { x: 0, y: 76, z: 0 }, STANDING);

    expect(sample.level).toBe(0);
    expect(sample.kind).toBeNull();
  });

  it("wades at level 1 when only the feet are wet", () => {
    // Origin 100: feet 76, waist 93, eye 134. Surface at 80 covers the foot
    // probe (77) and nothing else.
    const sample = sampleLiquid(pool(80), { x: 0, y: 100, z: 0 }, STANDING);

    expect(sample.level).toBe(1);
    expect(sample.kind).toBe("water");
  });

  it("swims at level 2 when the waist is under", () => {
    // Waist sits at 105 for a standing player at origin 100.
    const sample = sampleLiquid(pool(110), { x: 0, y: 100, z: 0 }, STANDING);

    expect(sample.level).toBe(2);
    expect(isSwimming(sample.level)).toBe(true);
  });

  it("submerges at level 3 when the eye is under", () => {
    const sample = sampleLiquid(pool(200), { x: 0, y: 100, z: 0 }, STANDING);

    expect(sample.level).toBe(3);
  });

  it("returns dry with no collision world", () => {
    expect(sampleLiquid(null, { x: 0, y: 0, z: 0 }, STANDING).level).toBe(0);
  });

  it("returns dry in an empty world", () => {
    expect(sampleLiquid(DRY, { x: 0, y: 0, z: 0 }, STANDING).level).toBe(0);
  });
});

describe("sampleLiquid — probe geometry", () => {
  it("lifts the foot probe one unit off the hull floor", () => {
    // Q3 probes at feet+1 so a player resting on the bottom of a drained pool
    // is not reading the floor it stands on. Feet at 76; a surface at exactly
    // 76 must not register, one at 77 must.
    const origin = { x: 0, y: 100, z: 0 };

    expect(sampleLiquid(pool(76), origin, STANDING).level).toBe(0);
    expect(sampleLiquid(pool(77), origin, STANDING).level).toBe(1);
  });

  it("measures the waist from the feet, not from the lifted foot probe", () => {
    // Q3: mid = origin + MINS_Z + (viewheight - MINS_Z)/2, measured from the
    // hull floor. Standing at origin 100 that is 76 + (134-76)/2 = 105.
    // Deriving it from the foot probe instead would put it at 105.5 — half a
    // unit high, invisible in play, and a silent divergence from the reference
    // in a path that feeds prediction and replay.
    const origin = { x: 0, y: 100, z: 0 };

    expect(sampleLiquid(pool(105), origin, STANDING).level).toBe(2);
    // A surface just below the true midpoint leaves the waist clear.
    expect(sampleLiquid(pool(104.9), origin, STANDING).level).toBe(1);
  });

  it("puts the eye probe exactly at view height", () => {
    const origin = { x: 0, y: 100, z: 0 };

    expect(sampleLiquid(pool(134), origin, STANDING).level).toBe(3);
    expect(sampleLiquid(pool(133.9), origin, STANDING).level).toBe(2);
  });

  it("uses the crouched hull and eye height when crouched", () => {
    // Crouched at origin 100: feet 96, waist 104, eye 112.
    // Standing at origin 100: feet 76, waist 105, eye 134.
    // The same water that leaves a standing player's head clear submerges a
    // crouched one — which is why the caller has to resolve crouch before it
    // samples, rather than the sampler assuming a hull.
    const origin = { x: 0, y: 100, z: 0 };

    expect(sampleLiquid(pool(112), origin, CROUCHED).level).toBe(3);
    expect(sampleLiquid(pool(112), origin, STANDING).level).toBe(2);
  });

  it("samples the same column the player occupies", () => {
    // Guards against sampling the origin's column while the probes drift.
    const columnOnly: PointContentsSource = {
      pointContents: (p) => (p.x === 500 && p.z === -300 && p.y <= 200 ? Contents.WATER : 0),
    };

    expect(sampleLiquid(columnOnly, { x: 500, y: 100, z: -300 }, STANDING).level).toBe(3);
    expect(sampleLiquid(columnOnly, { x: 0, y: 100, z: 0 }, STANDING).level).toBe(0);
  });
});

describe("sampleLiquid — kinds and raw contents", () => {
  it("names slime and lava", () => {
    expect(sampleLiquid(pool(200, Contents.SLIME), { x: 0, y: 100, z: 0 }, STANDING).kind).toBe("slime");
    expect(sampleLiquid(pool(200, Contents.LAVA), { x: 0, y: 100, z: 0 }, STANDING).kind).toBe("lava");
  });

  it("prefers the more hostile liquid when a brush is both", () => {
    // Four shipped shaders declare water and slime on one brush. Slime is the
    // bit with consequences, so it decides the kind.
    const both = pool(200, Contents.WATER | Contents.SLIME);

    expect(sampleLiquid(both, { x: 0, y: 100, z: 0 }, STANDING).kind).toBe("slime");
  });

  it("preserves both bits in rawContents even though kind picked one", () => {
    const sample = sampleLiquid(pool(200, Contents.WATER | Contents.SLIME), { x: 0, y: 100, z: 0 }, STANDING);

    expect(sample.rawContents & Contents.WATER).toBeTruthy();
    expect(sample.rawContents & Contents.SLIME).toBeTruthy();
  });

  it("masks out non-liquid contents", () => {
    // Fog, triggers and translucency share the volume; none of them are liquid.
    const noisy: PointContentsSource = {
      pointContents: () => Contents.WATER | Contents.TRIGGER,
    };

    const sample = sampleLiquid(noisy, { x: 0, y: 100, z: 0 }, STANDING);

    expect(sample.rawContents).toBe(Contents.WATER);
  });

  it("records each probe separately", () => {
    const sample = sampleLiquid(pool(105), { x: 0, y: 100, z: 0 }, STANDING);

    expect(sample.footContents).toBe(Contents.WATER);
    expect(sample.waistContents).toBe(Contents.WATER);
    expect(sample.eyeContents).toBe(0);
  });

  it("does not probe above a dry foot", () => {
    // Cheapest correct behaviour, and it also means a dry sample can never
    // report contents from a volume the player is not touching.
    let probes = 0;
    const counting: PointContentsSource = {
      pointContents: () => {
        probes++;
        return 0;
      },
    };

    sampleLiquid(counting, { x: 0, y: 100, z: 0 }, STANDING);

    expect(probes).toBe(1);
  });
});

describe("liquidTransitions", () => {
  const at = (level: 0 | 1 | 2 | 3): LiquidSample => ({
    level,
    kind: level > 0 ? "water" : null,
    rawContents: level > 0 ? Contents.WATER : 0,
    footContents: 0,
    waistContents: 0,
    eyeContents: 0,
  });

  it("reports entering the water", () => {
    expect(liquidTransitions(at(0), at(1)).entered).toBe(true);
  });

  it("reports leaving the water", () => {
    expect(liquidTransitions(at(2), at(0)).exited).toBe(true);
  });

  it("reports the head going under", () => {
    expect(liquidTransitions(at(2), at(3)).headUnder).toBe(true);
  });

  it("reports the head coming clear while still swimming", () => {
    const t = liquidTransitions(at(3), at(2));

    expect(t.headClear).toBe(true);
    expect(t.exited).toBe(false);
  });

  it("reports both head-clear and exit when a submerged player leaves entirely", () => {
    const t = liquidTransitions(at(3), at(0));

    expect(t.headClear).toBe(true);
    expect(t.exited).toBe(true);
  });

  it("reports nothing when the level is unchanged", () => {
    expect(liquidTransitions(at(2), at(2))).toEqual({
      entered: false,
      exited: false,
      headUnder: false,
      headClear: false,
    });
  });

  it("does not re-fire entering while already wet", () => {
    expect(liquidTransitions(at(1), at(3)).entered).toBe(false);
  });
});

describe("fallDamageScale", () => {
  it("follows the Q3 ladder", () => {
    expect(fallDamageScale(0)).toBe(1);
    expect(fallDamageScale(1)).toBe(0.5);
    expect(fallDamageScale(2)).toBe(0.25);
    expect(fallDamageScale(3)).toBe(0);
  });
});
