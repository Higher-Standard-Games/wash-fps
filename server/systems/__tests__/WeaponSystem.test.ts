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

import { EntityType } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWHEIGHT } from "../../../../../engine/physics/PlayerPhysicsConstants";
import { fireIntervalTicks, WeaponSystem } from "../WeaponSystem";

const FIRE_BUTTON = 1 << 8; // must match InputComponent.FIRE
const RELOAD_BUTTON = 1 << 10; // must match InputComponent.RELOAD

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

const mgLoadout = { weapons: ["machinegun"], ammo: { machinegun: 160 }, health: 100, armor: 0 };

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

describe("WeaponSystem - F3 reload models", () => {
  it("clip weapons deduct from clip and manual reload moves reserve into the magazine", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);

    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, 1000);

    sys.update(makeState([shooter, target]) as never, 1 / 125, 13 as never);
    expect(sys.getPendingDamage()).toHaveLength(1);

    let ammo = sys.getWeaponState(1 as never)!.ammo.get("machinegun")!;
    expect(ammo).toEqual({ clip: 39, reserve: 120 });

    shooter.input.buttons = RELOAD_BUTTON;
    sys.update(makeState([shooter, target]) as never, 1 / 125, 14 as never);
    expect(sys.getWeaponState(1 as never)!.reloading).toBe(true);

    shooter.input.buttons = FIRE_BUTTON;
    sys.update(makeState([shooter, target]) as never, 1 / 125, 26 as never);
    expect(sys.getPendingDamage()).toHaveLength(0);

    shooter.input.buttons = 0;
    sys.update(makeState([shooter, target]) as never, 1 / 125, 31 as never);
    ammo = sys.getWeaponState(1 as never)!.ammo.get("machinegun")!;
    expect(sys.getWeaponState(1 as never)!.reloading).toBe(false);
    expect(ammo).toEqual({ clip: 40, reserve: 119 });
  });

  it("auto-reloads clip weapons when the magazine is emptied", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["machinegun"], ammo: { machinegun: 41 }, health: 100, armor: 0 } as never,
    );

    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, 1000);
    const interval = fireIntervalTicks({ fireRate: 10 });

    for (let shot = 1; shot <= 40; shot++) {
      sys.update(makeState([shooter, target]) as never, 1 / 125, (shot * interval) as never);
      sys.getPendingDamage();
    }

    let state = sys.getWeaponState(1 as never)!;
    expect(state.reloading).toBe(true);
    expect(state.ammo.get("machinegun")).toEqual({ clip: 0, reserve: 1 });

    shooter.input.buttons = 0;
    sys.update(makeState([shooter, target]) as never, 1 / 125, (40 * interval + 17) as never);
    state = sys.getWeaponState(1 as never)!;
    expect(state.reloading).toBe(false);
    expect(state.ammo.get("machinegun")).toEqual({ clip: 1, reserve: 0 });
  });

  it("pool weapons deduct from the pool and never start reload", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["rlauncher"], ammo: { rlauncher: 1 }, health: 100, armor: 0 } as never,
    );

    const shooter = makeShooter(0, 0);
    shooter.input.buttons = 1 << 9; // Hold ADS before pressing fire to bypass hipfireBlocked delay.
    sys.update(makeState([shooter]) as never, 1 / 125, 99 as never);
    shooter.input.buttons = FIRE_BUTTON | (1 << 9);
    sys.update(makeState([shooter]) as never, 1 / 125, 100 as never);

    const state = sys.getWeaponState(1 as never)!;
    expect(state.reloading).toBe(false);
    expect(state.ammo.get("rlauncher")).toEqual({ clip: 0, reserve: 0 });

    sys.update(makeState([shooter]) as never, 1 / 125, 200 as never);
    expect(sys.getWeaponState(1 as never)!.reloading).toBe(false);
    expect(sys.getPendingFireEvents()).toHaveLength(1);
  });

  it("none weapons keep infinite ammo semantics", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["blade"], ammo: { blade: 1 }, health: 100, armor: 0 } as never,
    );

    const shooter = makeShooter(0, 0);
    sys.update(makeState([shooter]) as never, 1 / 125, 100 as never);

    const state = sys.getWeaponState(1 as never)!;
    expect(state.reloading).toBe(false);
    expect(state.ammo.get("blade")).toEqual({ clip: 1, reserve: 0 });
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

describe("WeaponSystem — F4 instagun insta-jump (hitscan splash-knockback)", () => {
  // Collision world stub: the ray always hits a floor just below the shooter.
  const floorImpact = { fraction: 0.5, hitPoint: { x: 0, y: -6, z: 0 }, normal: { x: 0, y: 1, z: 0 } };
  const collisionWorld = { trace: () => floorImpact };
  const instaLoadout = { weapons: ["instagun"], ammo: { instagun: 5 }, health: 100, armor: 0 };

  it("launches the shooter (upward knockback) with zero self-damage in instagib", () => {
    const sys = new WeaponSystem();
    sys.setCollisionWorld(collisionWorld as never);
    sys.selfDamageMultiplier = 0; // instagib: no self-damage
    sys.initializeWeaponFromLoadout(1 as never, instaLoadout as never);

    const shooter = makeShooter(0, 1.5); // aim steeply down at the floor
    sys.update(makeState([shooter]) as never, 1 / 125, 200 as never);

    const selfEvent = sys.getPendingDamage().find((d) => d.victimId === 1);
    expect(selfEvent).toBeDefined();
    expect(selfEvent!.damage).toBe(0); // no suicide
    expect(selfEvent!.knockbackDamage).toBeGreaterThan(0); // but still launched
    expect(selfEvent!.knockbackDir!.y).toBeGreaterThan(0); // impact below → pushed up
  });

  it("does no self-knockback when there is no collision world (guard)", () => {
    const sys = new WeaponSystem();
    sys.selfDamageMultiplier = 0;
    sys.initializeWeaponFromLoadout(1 as never, instaLoadout as never);

    const shooter = makeShooter(0, 1.5);
    sys.update(makeState([shooter]) as never, 1 / 125, 200 as never);

    expect(sys.getPendingDamage()).toHaveLength(0);
  });
});

describe("WeaponSystem — F5 voltaic chain lightning", () => {
  /** Plain living target at an absolute position (no input → never fires). */
  function targetAt(id: number, x: number, y: number, z: number) {
    return {
      id,
      transform: { position: { x, y, z } },
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
  }

  const voltaicLoadout = { weapons: ["voltaic"], ammo: { voltaic: 150 }, health: 100, armor: 0 };

  it("arcs from the primary hit to nearby enemies with per-hop falloff", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, voltaicLoadout as never);

    const shooter = makeShooter(0, 0); // aim level +z
    shooter.input.buttons |= 1 << 9; // ADS → beam locked straight (isolate chaining from wander)
    const primary = targetAt(2, 0, DEFAULT_VIEWHEIGHT, 500); // on the ray
    const chain1 = targetAt(3, 100, DEFAULT_VIEWHEIGHT, 500); // off-ray, near primary
    const chain2 = targetAt(4, 100, DEFAULT_VIEWHEIGHT, 620); // near chain1, not primary

    sys.update(makeState([shooter, primary, chain1, chain2]) as never, 1 / 125, 100 as never);

    const dmg = sys.getPendingDamage();
    const byVictim = new Map(dmg.map((d) => [d.victimId as unknown as number, d.damage]));

    // voltaic damage 7; chainFalloff 0.5 → primary 7, hop1 round(3.5)=4, hop2 round(1.75)=2
    expect(byVictim.get(2)).toBe(7);
    expect(byVictim.get(3)).toBe(4);
    expect(byVictim.get(4)).toBe(2);
    expect(dmg).toHaveLength(3); // primary + 2 chained (chainCount 2), no double-hits
  });

  it("does not chain past chainRadius", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, voltaicLoadout as never);

    const shooter = makeShooter(0, 0);
    shooter.input.buttons |= 1 << 9; // ADS → straight beam
    const primary = targetAt(2, 0, DEFAULT_VIEWHEIGHT, 500);
    const farAway = targetAt(3, 5000, DEFAULT_VIEWHEIGHT, 500); // > chainRadius from primary

    sys.update(makeState([shooter, primary, farAway]) as never, 1 / 125, 100 as never);

    const dmg = sys.getPendingDamage();
    expect(dmg).toHaveLength(1); // only the primary hit
    expect(dmg[0].victimId as unknown as number).toBe(2);
  });
});

describe("WeaponSystem — voltaic hipfire beam wander (ADS downside)", () => {
  const ALT_FIRE = 1 << 9;
  const voltaicLoadout = { weapons: ["voltaic"], ammo: { voltaic: 150 }, health: 100, armor: 0 };

  /** Fire voltaic for 600 ticks at a small target 800u out; return the hit count. */
  function countHits(ads: boolean): number {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, voltaicLoadout as never);
    const shooter = {
      id: 1,
      ownerId: 1,
      transform: { position: { x: 0, y: 0, z: 0 } },
      input: { buttons: (1 << 8) | (ads ? ALT_FIRE : 0), yaw: 0, pitch: 0, weaponSlot: 0 },
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
    const target = {
      id: 2,
      transform: { position: { x: 0, y: DEFAULT_VIEWHEIGHT, z: 800 } }, // on the straight ray
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
    let hits = 0;
    for (let tick = 1; tick <= 600; tick++) {
      sys.update(makeState([shooter, target]) as never, 1 / 125, tick as never);
      hits += sys.getPendingDamage().filter((d) => (d.victimId as unknown as number) === 2).length;
    }
    return hits;
  }

  it("ADS is pinpoint (every shot hits) while hipfire drifts off a distant target", () => {
    const adsHits = countHits(true);
    const hipHits = countHits(false);

    expect(adsHits).toBe(99); // 600 ticks / 6-tick interval, minus one reload pause
    expect(hipHits).toBeLessThan(adsHits); // wander makes the hip beam miss at range
    expect(hipHits).toBeGreaterThan(0); // still lands near the wander zero-crossings
  });
});

describe("WeaponSystem — F8 projectiles registered by projectileId", () => {
  it("firing rlauncher registers the projectile as 'rocket' (not the weapon id)", () => {
    const sys = new WeaponSystem();
    let registeredDefId = "";
    sys.setProjectileSystem({
      registerProjectileType: (_id: unknown, defId: string) => {
        registeredDefId = defId;
      },
    } as never);
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["rlauncher"], ammo: { rlauncher: 5 }, health: 100, armor: 0 } as never,
    );

    const shooter = makeShooter(0, 0);
    shooter.input.buttons = 1 << 9; // hold ADS first to bypass rlauncher's hipfireBlocked delay
    sys.update(makeState([shooter]) as never, 1 / 125, 99 as never);
    shooter.input.buttons = FIRE_BUTTON | (1 << 9);
    sys.update(makeState([shooter]) as never, 1 / 125, 100 as never);

    expect(registeredDefId).toBe("rocket");
  });
});
describe("WeaponSystem - WO-5 weapon switch gate", () => {
  it("rate-limits manual weapon switches while requiring a fresh edge after cooldown", () => {
    const sys = new WeaponSystem();
    const shooter = {
      id: 1,
      ownerId: 1,
      transform: { position: { x: 0, y: 0, z: 0 } },
      input: { buttons: 0, yaw: 0, pitch: 0, weaponSlot: 0 },
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
    const state = makeState([shooter]);
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["blade", "machinegun"], ammo: { blade: 1, machinegun: 160 }, health: 100, armor: 0 } as never,
    );
    const weapon = () => sys.getWeaponState(1 as never)!.currentWeapon;

    shooter.input.weaponSlot = 2;
    sys.update(state as never, 1 / 125, 100 as never);
    expect(weapon()).toBe("machinegun");

    shooter.input.weaponSlot = 1;
    sys.update(state as never, 1 / 125, 110 as never);
    expect(weapon()).toBe("machinegun");

    shooter.input.weaponSlot = 2;
    sys.update(state as never, 1 / 125, 120 as never);
    shooter.input.weaponSlot = 1;
    sys.update(state as never, 1 / 125, 130 as never);
    expect(weapon()).toBe("blade");
  });
});
