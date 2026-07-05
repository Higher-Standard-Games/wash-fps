/**
 * WeaponSystem headless harness / regressions.
 *
 * Covers two v0.9.16 weapon-overhaul correctness fixes:
 *
 *  F2 — single-ray hitscan pitch inversion. `fireHitscan` double-negated pitch
 *       (`const p = -pitch`, where `pitch` is already `-input.pitch`), so the
 *       machinegun/electrobolt/instagun damage ray had the opposite vertical sign
 *       to the tracer visual and every other fire path. Symptom: aiming up hit low.
 *
 *  F1 — fire cadence used `Math.floor(125 / fireRate)`, truncating so weapons whose
 *       rate doesn't divide 125 fired slightly fast. Now `round` (nearest tick),
 *       overridable per weapon via `fireIntervalTicks`.
 *
 * Uses a minimal duck-typed WorldState/entity stub — the only surface
 * WeaponSystem.update touches for hitscan is entitiesByType + transform/input/health.
 */

import { describe, expect, it } from "vitest";
import { EntityType } from "@engine/server/ecs/types";
import { DEFAULT_VIEWHEIGHT } from "../../../../../engine/physics/PlayerPhysicsConstants";
import { fireIntervalTicks, WeaponSystem } from "../WeaponSystem";

const FIRE_BUTTON = 1 << 8; // must match InputComponent.FIRE

/** Canonical look direction (matches fireProjectile / fireMelee / fire-event). */
function look(yaw: number, pitchInput: number) {
  const pitch = -pitchInput; // Babylon: up = negative input pitch
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };
}

function makeShooter(yaw: number, pitchInput: number) {
  return {
    id: 1,
    ownerId: 1,
    transform: { position: { x: 0, y: 0, z: 0 } },
    input: { buttons: FIRE_BUTTON, yaw, pitch: pitchInput, weaponSlot: 0 },
    health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
  };
}

/** A dummy target with no `input` — never fires, but is a valid hitscan target. */
function makeTargetAlongRay(yaw: number, pitchInput: number, dist: number) {
  const d = look(yaw, pitchInput);
  return {
    id: 2,
    transform: {
      position: {
        x: 0 + d.x * dist,
        y: DEFAULT_VIEWHEIGHT + d.y * dist, // ray starts at eye height
        z: 0 + d.z * dist,
      },
    },
    health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
  };
}

function makeState(entities: unknown[]) {
  return {
    entitiesByType: (t: EntityType) => (t === EntityType.Player ? entities : []),
    getEntity: (id: number) => entities.find((e) => (e as { id: number }).id === id),
    getEntityMut: (id: number) => entities.find((e) => (e as { id: number }).id === id),
    addEntity: () => {},
    removeEntity: () => {},
  };
}

const mgLoadout = { weapons: ["machinegun"], ammo: { machinegun: 100 }, health: 100, armor: 0 };

describe("WeaponSystem — F2 hitscan vertical aim", () => {
  for (const [label, pitchInput] of [
    ["level", 0],
    ["aiming up", -0.35],
    ["aiming down", 0.35],
  ] as const) {
    it(`machinegun hits a target placed along the aim ray (${label})`, () => {
      const sys = new WeaponSystem();
      sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);

      const shooter = makeShooter(0, pitchInput);
      const target = makeTargetAlongRay(0, pitchInput, 1000);

      // tick 100 >> fire interval, so the (first) shot is not gated
      sys.update(makeState([shooter, target]) as never, 1 / 125, 100 as never);

      const dmg = sys.getPendingDamage();
      expect(dmg.map((d) => d.victimId)).toContain(2);
    });
  }

  it("does NOT hit a target on the opposite vertical side (guards the inversion)", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);

    const shooter = makeShooter(0, -0.35); // aiming UP
    const targetBelow = makeTargetAlongRay(0, 0.35, 1000); // placed DOWN

    sys.update(makeState([shooter, targetBelow]) as never, 1 / 125, 100 as never);

    expect(sys.getPendingDamage()).toHaveLength(0);
  });
});

describe("WeaponSystem — F1 fire cadence", () => {
  it("uses nearest tick (round), not floor, and respects an explicit override", () => {
    // machinegun fireRate 10 → 125/10 = 12.5 → round 13 (floor would be 12)
    expect(fireIntervalTicks({ fireRate: 10 })).toBe(13);
    // exact divisors are unchanged
    expect(fireIntervalTicks({ fireRate: 1.25 })).toBe(100);
    // explicit tick override wins over fireRate
    expect(fireIntervalTicks({ fireRate: 10, fireIntervalTicks: 20 })).toBe(20);
    // clamped to at least 1 tick
    expect(fireIntervalTicks({ fireRate: 1000 })).toBe(1);
  });

  it("machinegun lands shots on a fixed tick interval when fire is held", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);

    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, 1000);

    const fireTicks: number[] = [];
    for (let tick = 1; tick <= 60; tick++) {
      sys.update(makeState([shooter, target]) as never, 1 / 125, tick as never);
      if (sys.getPendingDamage().length > 0) fireTicks.push(tick);
    }

    const expected = fireIntervalTicks({ fireRate: 10 }); // 13
    expect(fireTicks[0]).toBe(expected);
    const gaps = fireTicks.slice(1).map((t, i) => t - fireTicks[i]);
    expect([...new Set(gaps)]).toEqual([expected]);
  });
});
