/**
 * Swimming physics (water Phase 2).
 *
 * Pure functions only; the branch that calls them is covered by
 * `SwimMovement.test.ts` against the real collision stack.
 */

import { describe, expect, it } from "vitest";
import {
  applyWaterFriction,
  checkWaterJump,
  DEFAULT_LIQUID_MOVEMENT,
  idleSinkVelocity,
  swimIntent,
  wadeSpeedScale,
  waterAccelerate,
} from "../Swim";

const P = DEFAULT_LIQUID_MOVEMENT;

describe("applyWaterFriction", () => {
  it("drags all three axes, not just the horizontal ones", () => {
    // The distinction from ground friction: a swimmer's vertical motion is
    // theirs, so the water has to resist it.
    const vel = { x: 100, y: 100, z: 100 };

    applyWaterFriction(vel, 3, P, 100, 0.1);

    expect(vel.x).toBeLessThan(100);
    expect(vel.y).toBeLessThan(100);
    expect(vel.z).toBeLessThan(100);
  });

  it("drags harder the deeper you are", () => {
    const shallow = { x: 300, y: 0, z: 0 };
    const deep = { x: 300, y: 0, z: 0 };

    applyWaterFriction(shallow, 1, P, 100, 0.1);
    applyWaterFriction(deep, 3, P, 100, 0.1);

    expect(deep.x).toBeLessThan(shallow.x);
  });

  it("does nothing on dry land", () => {
    const vel = { x: 300, y: 0, z: 0 };

    applyWaterFriction(vel, 0, P, 100, 0.1);

    expect(vel.x).toBe(300);
  });

  it("stops a crawl completely instead of halving it forever", () => {
    const vel = { x: 0.4, y: 0.3, z: 0.2 };

    applyWaterFriction(vel, 2, P, 100, 0.1);

    expect(vel).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("respects a profile that only drags once swimming", () => {
    const vel = { x: 300, y: 0, z: 0 };

    applyWaterFriction(vel, 1, { ...P, frictionStartsAtLevel: 2 }, 100, 0.1);

    expect(vel.x).toBe(300);
  });
});

describe("waterAccelerate", () => {
  it("accelerates along the wish direction in three dimensions", () => {
    const vel = { x: 0, y: 0, z: 0 };

    waterAccelerate(vel, { x: 0, y: 1, z: 0 }, 140, 4, 0.1);

    expect(vel.y).toBeGreaterThan(0);
    expect(vel.x).toBe(0);
    expect(vel.z).toBe(0);
  });

  it("never pushes past the wish speed", () => {
    const vel = { x: 0, y: 0, z: 0 };

    for (let i = 0; i < 500; i++) {
      waterAccelerate(vel, { x: 1, y: 0, z: 0 }, 140, 4, 1 / 125);
    }

    expect(vel.x).toBeLessThanOrEqual(140.001);
  });

  it("does nothing when already moving faster than asked", () => {
    const vel = { x: 400, y: 0, z: 0 };

    waterAccelerate(vel, { x: 1, y: 0, z: 0 }, 140, 4, 0.1);

    expect(vel.x).toBe(400);
  });
});

describe("wadeSpeedScale", () => {
  it("is full speed on dry land", () => {
    expect(wadeSpeedScale(0, P)).toBe(1);
  });

  it("interpolates toward the swim cap by depth", () => {
    // Continuous rather than a step, so walking into a pool slows you
    // gradually instead of at a threshold.
    expect(wadeSpeedScale(1, P)).toBeCloseTo(1 - 0.5 / 3, 5);
    expect(wadeSpeedScale(2, P)).toBeCloseTo(1 - 1 / 3, 5);
    expect(wadeSpeedScale(3, P)).toBeCloseTo(0.5, 5);
  });
});

describe("swimIntent", () => {
  const level = { pitch: 0, yaw: 0 };

  it("swims where the player is looking, pitch included", () => {
    // Looking up and holding forward must swim upward. Flattening forward the
    // way ground movement does would make surfacing impossible without Space.
    const lookingUp = { pitch: -Math.PI / 4, yaw: 0 };

    const intent = swimIntent({ x: 0, y: 0, z: 1 }, lookingUp, 0, 280, P);

    expect(intent.dir).not.toBeNull();
    expect(intent.dir?.y).toBeGreaterThan(0);
  });

  it("swims downward when looking down", () => {
    const lookingDown = { pitch: Math.PI / 4, yaw: 0 };

    const intent = swimIntent({ x: 0, y: 0, z: 1 }, lookingDown, 0, 280, P);

    expect(intent.dir?.y).toBeLessThan(0);
  });

  it("ascends on jump regardless of view direction", () => {
    const lookingDown = { pitch: Math.PI / 3, yaw: 0 };

    const intent = swimIntent({ x: 0, y: 0, z: 0 }, lookingDown, 1, 280, P);

    expect(intent.dir?.y).toBe(1);
  });

  it("descends on crouch regardless of view direction", () => {
    const intent = swimIntent({ x: 0, y: 0, z: 0 }, { pitch: -Math.PI / 3, yaw: 0 }, -1, 280, P);

    expect(intent.dir?.y).toBe(-1);
  });

  it("caps the wish speed at half of base", () => {
    const intent = swimIntent({ x: 0, y: 0, z: 1 }, level, 0, 280, P);

    expect(intent.speed).toBeCloseTo(140, 5);
  });

  it("does not let diagonal input exceed a straight line", () => {
    const straight = swimIntent({ x: 0, y: 0, z: 1 }, level, 0, 280, P);
    const diagonal = swimIntent({ x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }, level, 1, 280, P);

    expect(diagonal.speed).toBeLessThanOrEqual(straight.speed + 0.001);
  });

  it("reports no direction when the player asks for nothing", () => {
    const intent = swimIntent({ x: 0, y: 0, z: 0 }, level, 0, 280, P);

    expect(intent.dir).toBeNull();
    expect(intent.speed).toBe(0);
  });

  it("respects yaw when decomposing the wish direction", () => {
    // Facing +X (yaw 90 degrees), a forward command arrives as world +X and
    // must stay pointing that way.
    const facingX = { pitch: 0, yaw: Math.PI / 2 };

    const intent = swimIntent({ x: 1, y: 0, z: 0 }, facingX, 0, 280, P);

    expect(intent.dir?.x).toBeCloseTo(1, 5);
    expect(intent.dir?.z).toBeCloseTo(0, 5);
  });
});

describe("idleSinkVelocity", () => {
  it("sinks rather than hovering", () => {
    expect(idleSinkVelocity(P).y).toBe(-60);
  });
});

describe("checkWaterJump", () => {
  const origin = { x: 0, y: 100, z: 0 };
  const facingZ = { pitch: 0, yaw: 0 };

  /** Solid everywhere below `topY` — a wall the player is treading against. */
  const wallUpTo = (topY: number) => (p: { y: number }) => p.y < topY;
  /** Open air above the ledge: the ordinary case. */
  const noLiquid = () => false;

  it("launches over a lip that has clear air above it", () => {
    // Solid at chest height 30 units ahead, clear 16 above: a ledge.
    expect(checkWaterJump(origin, facingZ, 2, wallUpTo(110), noLiquid)).toBe(true);
  });

  it("does not launch into a wall", () => {
    // Solid at chest height AND above it: no way out here.
    expect(checkWaterJump(origin, facingZ, 2, () => true, noLiquid)).toBe(false);
  });

  it("does not launch with nothing ahead", () => {
    expect(checkWaterJump(origin, facingZ, 2, () => false, noLiquid)).toBe(false);
  });

  it("does not launch onto a shelf that is still underwater", () => {
    // A step inside a deep pool is solid at chest height with clear space
    // above it, so a solid-only check calls it a way out — and a player
    // treading over the shallow end gets thrown by a launch they did not ask
    // for, losing control for two seconds. A way out has AIR above it.
    expect(checkWaterJump(origin, facingZ, 2, wallUpTo(110), () => true)).toBe(false);
  });

  it("only applies while treading at the surface", () => {
    // A fully submerged player is not at the edge of anything, and a wading
    // one can simply walk out.
    expect(checkWaterJump(origin, facingZ, 3, wallUpTo(110), noLiquid)).toBe(false);
    expect(checkWaterJump(origin, facingZ, 1, wallUpTo(110), noLiquid)).toBe(false);
    expect(checkWaterJump(origin, facingZ, 0, wallUpTo(110), noLiquid)).toBe(false);
  });

  it("probes ahead of where the player faces, not where they look", () => {
    // Pitch must not move the probe: this is about the ledge in front of you.
    const lookingUp = { pitch: -Math.PI / 3, yaw: 0 };
    const probes: Array<{ x: number; y: number; z: number }> = [];

    checkWaterJump(
      origin,
      lookingUp,
      2,
      (p) => {
        probes.push({ ...p });
        return p.y < 110;
      },
      noLiquid,
    );

    expect(probes[0].z).toBeCloseTo(30, 5);
    expect(probes[0].y).toBeCloseTo(104, 5);
  });
});
