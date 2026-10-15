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

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import type { Entity } from "@engine/server/ecs/Entity";
import { EntityType } from "@engine/server/ecs/types";
import { LAG_COMPENSATION } from "@engine/server/lagcomp/config";
import { LagCompensation } from "@engine/server/lagcomp/LagCompensation";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VIEWHEIGHT } from "../../../../../engine/physics/PlayerPhysicsConstants";
import { GRENADE } from "../../../../../shared/entities/definitions/projectiles/grenade";
import { GRENADE_LAUNCHER } from "../../../../../shared/entities/definitions/weapons/glauncher";
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

/**
 * How far down the aim ray the targets stand. The machinegun's shots spread (up
 * to a 6° cone held from the hip), so a target has to be close enough that every
 * shot in the cone lands on its 32-unit hit sphere: 200 × tan 6° is 21 units.
 * These tests are about aim, cadence, occlusion and lag compensation, not spread.
 */
const TARGET_DISTANCE = 200;

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
      const target = makeTargetAlongRay(0, pitchInput, TARGET_DISTANCE);

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
    const targetBelow = makeTargetAlongRay(0, 0.35, TARGET_DISTANCE); // placed DOWN

    sys.update(makeState([shooter, targetBelow]) as never, 1 / 125, 100 as never);

    expect(sys.getPendingDamage()).toHaveLength(0);
  });
});

describe("WeaponSystem — hitscan world occlusion (no shooting through floors/walls)", () => {
  // A collision-world stub that reports a solid surface on the ray at a fixed
  // distance ahead (z), mirroring a floor/wall between shooter and target.
  const wallAt = (z: number) => ({
    trace: () => ({
      hit: true,
      fraction: 0.5,
      hitPoint: { x: 0, y: DEFAULT_VIEWHEIGHT, z },
      normal: { x: 0, y: 0, z: -1 },
    }),
  });

  it("does NOT hit a target that stands behind world geometry", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);
    sys.setCollisionWorld(wallAt(TARGET_DISTANCE / 2) as never); // wall halfway to the target

    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, TARGET_DISTANCE);

    sys.update(makeState([shooter, target]) as never, 1 / 125, 100 as never);

    expect(sys.getPendingDamage()).toHaveLength(0);
  });

  it("still hits a target when the world impact is beyond it (clear line of sight)", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);
    sys.setCollisionWorld(wallAt(1500) as never); // wall well past the target

    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, TARGET_DISTANCE);

    sys.update(makeState([shooter, target]) as never, 1 / 125, 100 as never);

    expect(sys.getPendingDamage().map((d) => d.victimId)).toContain(2);
  });
});

describe("WeaponSystem - F3 reload models", () => {
  it("clip weapons deduct from clip and manual reload moves reserve into the magazine", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);

    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, TARGET_DISTANCE);

    sys.update(makeState([shooter, target]) as never, 1 / 125, 13 as never);
    expect(sys.getPendingDamage()).toHaveLength(1);

    let ammo = sys.getWeaponState(1 as never)!.ammo.get("machinegun")!;
    // MG: 30-round clip, 120 reserve (loadout 160 capped at clip 30 + reserve 120 = 150).
    expect(ammo).toEqual({ clip: 29, reserve: 120 });

    shooter.input.buttons = RELOAD_BUTTON;
    sys.update(makeState([shooter, target]) as never, 1 / 125, 14 as never);
    expect(sys.getWeaponState(1 as never)!.reloading).toBe(true);

    shooter.input.buttons = FIRE_BUTTON;
    sys.update(makeState([shooter, target]) as never, 1 / 125, 26 as never);
    expect(sys.getPendingDamage()).toHaveLength(0);

    shooter.input.buttons = 0;
    // Reload completes at tick 14 + ceil(1.5×125)=188 → tick 202; sample after.
    sys.update(makeState([shooter, target]) as never, 1 / 125, 203 as never);
    ammo = sys.getWeaponState(1 as never)!.ammo.get("machinegun")!;
    expect(sys.getWeaponState(1 as never)!.reloading).toBe(false);
    expect(ammo).toEqual({ clip: 30, reserve: 119 });
  });

  it("auto-reloads clip weapons when the magazine is emptied", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["machinegun"], ammo: { machinegun: 41 }, health: 100, armor: 0 } as never,
    );

    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, TARGET_DISTANCE);
    const interval = fireIntervalTicks({ fireRate: 10 });

    for (let shot = 1; shot <= 40; shot++) {
      sys.update(makeState([shooter, target]) as never, 1 / 125, (shot * interval) as never);
      sys.getPendingDamage();
    }

    // Loadout 41 → clip 30 + reserve 11. Clip empties after 30 shots (tick 390),
    // auto-reload starts there and ends at 390 + ceil(1.5×125)=188 → tick 578.
    let state = sys.getWeaponState(1 as never)!;
    expect(state.reloading).toBe(true);
    expect(state.ammo.get("machinegun")).toEqual({ clip: 0, reserve: 11 });

    shooter.input.buttons = 0;
    sys.update(makeState([shooter, target]) as never, 1 / 125, (40 * interval + 100) as never);
    state = sys.getWeaponState(1 as never)!;
    expect(state.reloading).toBe(false);
    // 11 reserve top up the empty 30-round clip → clip 11, reserve 0.
    expect(state.ammo.get("machinegun")).toEqual({ clip: 11, reserve: 0 });
  });

  it("pool weapons deduct from the pool and never start reload", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["rlauncher"], ammo: { rlauncher: 1 }, health: 100, armor: 0 } as never,
    );

    const shooter = makeShooter(0, 0);
    shooter.input.buttons = 1 << 9; // Hold ADS before pressing fire to bypass hipfireBlocked delay.
    sys.update(makeState([shooter]) as never, 1 / 125, 80 as never);
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

describe("WeaponSystem - fire view origin", () => {
  it.each([
    [-0.7, -0.4],
    [0.7, 0.4],
    [2.3, -0.6],
  ])("launches ADS plasma along Babylon camera yaw %s / pitch %s", (yaw, pitch) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("aim", Vector3.Zero(), scene);
    try {
      camera.rotation.set(pitch, yaw, 0);
      const expectedDirection = camera.getDirection(Vector3.Forward());
      const sys = new WeaponSystem();
      sys.setProjectileSystem({ registerProjectileType: () => {} } as never);
      sys.initializeWeaponFromLoadout(
        1 as never,
        { weapons: ["plasmagun"], ammo: { plasmagun: 50 }, health: 100, armor: 0 } as never,
      );
      const shooter = makeShooter(yaw, pitch);
      shooter.transform.position = { x: 300, y: 80, z: -200 };
      const spawn = vi.fn<(entity: Entity) => void>();
      const state = { ...makeState([shooter]), addEntity: spawn };
      shooter.input.buttons = 1 << 9;
      sys.update(state as never, 1 / 125, 90 as never);
      shooter.input.buttons |= FIRE_BUTTON;
      sys.update(state as never, 1 / 125, 100 as never);
      expect(spawn).toHaveBeenCalledOnce();
      const projectile = spawn.mock.calls[0][0];
      const pos = projectile.transform!.position;
      const velocity = projectile.physics!.velocity;
      const expectedOrigin = new Vector3(300, 80 + DEFAULT_VIEWHEIGHT, -200).add(expectedDirection.scale(50));
      expect(Vector3.Distance(new Vector3(pos.x, pos.y, pos.z), expectedOrigin)).toBeLessThan(0.001);
      expect(
        Vector3.Distance(new Vector3(velocity.x, velocity.y, velocity.z).normalize(), expectedDirection),
      ).toBeLessThan(0.00001);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("emits hitscan fire events from the crouched view height", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);

    const shooter = makeShooter(0, 0);
    (shooter as any).physics = { crouchViewOffset: -20 };

    sys.update(makeState([shooter]) as never, 1 / 125, 100 as never);

    const fire = sys.getPendingFireEvents()[0];
    expect(fire.originX).toBeCloseTo(0, 6);
    expect(fire.originY).toBeCloseTo(DEFAULT_VIEWHEIGHT - 20, 6);
    expect(fire.originZ).toBeCloseTo(0, 6);
  });

  it("spawns projectile entities from the crouched view height", () => {
    const sys = new WeaponSystem();
    let spawnedProjectile: { transform?: { position?: { x?: number; y?: number; z?: number } } } | undefined;
    sys.setProjectileSystem({ registerProjectileType: () => {} } as never);
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["glauncher"], ammo: { glauncher: 5 }, health: 100, armor: 0 } as never,
    );

    const shooter = makeShooter(0, 0);
    (shooter as any).physics = { crouchViewOffset: -20 };
    const state = {
      ...makeState([shooter]),
      addEntity: (entity: { transform?: { position?: { x?: number; y?: number; z?: number } } }) => {
        spawnedProjectile = entity;
      },
    };

    shooter.input.buttons = 1 << 9; // hold ADS first to bypass glauncher's hipfireBlocked delay
    sys.update(state as never, 1 / 125, 80 as never);
    shooter.input.buttons = FIRE_BUTTON | (1 << 9);
    sys.update(state as never, 1 / 125, 100 as never);

    expect(spawnedProjectile?.transform?.position?.x).toBeCloseTo(0, 6);
    expect(spawnedProjectile?.transform?.position?.y).toBeCloseTo(DEFAULT_VIEWHEIGHT - 20, 6);
    expect(spawnedProjectile?.transform?.position?.z).toBeCloseTo(50, 6);
  });
});
describe("WeaponSystem - blade dash", () => {
  const bladeLoadout = { weapons: ["blade"], ammo: { blade: 1 }, health: 100, armor: 0 };

  it("queues a server-side melee dash when a blade primary swing is accepted", () => {
    const sys = new WeaponSystem();
    const queueMeleeDash = vi.fn();
    sys.setMovementSubsystem({ setSpeedBonus: vi.fn(), queueMeleeDash } as never);
    sys.initializeWeaponFromLoadout(1 as never, bladeLoadout as never);

    const shooter = makeShooter(Math.PI / 2, 0);
    sys.update(makeState([shooter]) as never, 1 / 125, 100 as never);

    expect(queueMeleeDash).toHaveBeenCalledTimes(1);
    const dash = queueMeleeDash.mock.calls[0][0];
    expect(dash).toMatchObject({ entityId: 1, distance: 48 });
    expect(dash.dirX).toBeCloseTo(1, 6);
    expect(dash.dirZ).toBeCloseTo(0, 6);
  });

  it("does not queue extra dashes while fire is held or cooldown-gated", () => {
    const sys = new WeaponSystem();
    const queueMeleeDash = vi.fn();
    sys.setMovementSubsystem({ setSpeedBonus: vi.fn(), queueMeleeDash } as never);
    sys.initializeWeaponFromLoadout(1 as never, bladeLoadout as never);

    const shooter = makeShooter(0, 0);
    const state = makeState([shooter]);

    sys.update(state as never, 1 / 125, 100 as never);
    sys.update(state as never, 1 / 125, 101 as never);
    shooter.input.buttons = 0;
    sys.update(state as never, 1 / 125, 102 as never);
    shooter.input.buttons = FIRE_BUTTON;
    sys.update(state as never, 1 / 125, 103 as never);

    expect(queueMeleeDash).toHaveBeenCalledTimes(1);
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
    const target = makeTargetAlongRay(0, 0, TARGET_DISTANCE);

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

describe("WeaponSystem — F5 continuous beam truth and voltaic chain lightning", () => {
  /** Plain living target at an absolute position (no input → never fires). */
  function targetAt(id: number, x: number, y: number, z: number) {
    return {
      id,
      transform: { position: { x, y, z } },
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
  }

  const voltaicLoadout = { weapons: ["voltaic"], ammo: { voltaic: 150 }, health: 100, armor: 0 };
  const lasergunLoadout = { weapons: ["lasergun"], ammo: { lasergun: 150 }, health: 100, armor: 0 };

  it("normalizes legacy Lasergun loadouts to the one canonical Voltaic state", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, lasergunLoadout as never);

    const weaponState = sys.getWeaponState(1 as never)!;
    expect(weaponState.currentWeapon).toBe("voltaic");
    expect(weaponState.weapons).toEqual(["voltaic"]);
    expect(weaponState.ammo.has("lasergun")).toBe(false);
    expect(sys.getAmmo(1 as never, "lasergun")).toBe(150);
  });

  it("replicates Voltaic beam truth after normalizing a legacy Lasergun loadout", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, lasergunLoadout as never);

    const shooter = makeShooter(0, 0);
    shooter.input.buttons = 1 << 9; // Establish ADS before pressing fire.
    const target = targetAt(2, 0, DEFAULT_VIEWHEIGHT, 500);

    sys.update(makeState([shooter, target]) as never, 1 / 125, 80 as never);
    shooter.input.buttons |= FIRE_BUTTON;
    sys.update(makeState([shooter, target]) as never, 1 / 125, 100 as never);

    const [beam] = sys.getPendingVoltaicBeamEvents();
    expect(beam).toBeDefined();
    expect(beam.impactKind).toBe(2);
    expect(beam.endZ).toBeCloseTo(468);
  });

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

    const [beam] = sys.getPendingVoltaicBeamEvents();
    expect(beam.impactKind).toBe(2);
    expect(beam.endX).toBeCloseTo(0);
    expect(beam.endY).toBeCloseTo(DEFAULT_VIEWHEIGHT);
    expect(beam.endZ).toBeCloseTo(468);
    expect(beam.normalZ).toBeCloseTo(-1);
  });

  it("replicates the authoritative BSP endpoint and normal on a world hit", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, voltaicLoadout as never);
    sys.setCollisionWorld({
      trace: () => ({
        hit: true,
        fraction: 0.5,
        hitPoint: { x: 0, y: DEFAULT_VIEWHEIGHT, z: 425 },
        normal: { x: 0, y: 0, z: -1 },
      }),
    } as never);
    const shooter = makeShooter(0, 0);
    shooter.input.buttons |= 1 << 9;

    sys.update(makeState([shooter]) as never, 1 / 125, 100 as never);

    const [beam] = sys.getPendingVoltaicBeamEvents();
    expect(beam).toMatchObject({
      impactKind: 1,
      endX: 0,
      endY: DEFAULT_VIEWHEIGHT,
      endZ: 425,
      normalX: 0,
      normalY: 0,
      normalZ: -1,
    });
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

  /** Fire voltaic for 600 ticks at a small target 800u out. */
  function sampleAccuracy(ads: boolean): { hits: number; shots: number } {
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
    let shots = 0;
    for (let tick = 1; tick <= 600; tick++) {
      sys.update(makeState([shooter, target]) as never, 1 / 125, tick as never);
      hits += sys.getPendingDamage().filter((d) => (d.victimId as unknown as number) === 2).length;
      shots += sys.getPendingVoltaicBeamEvents().length;
    }
    return { hits, shots };
  }

  it("ADS is pinpoint (every shot hits) while hipfire drifts off a distant target", () => {
    const ads = sampleAccuracy(true);
    const hip = sampleAccuracy(false);

    expect(ads.hits).toBe(ads.shots);
    expect(hip.shots).toBe(ads.shots);
    expect(hip.hits).toBeLessThan(ads.hits); // wander makes the hip beam miss at range
    expect(hip.hits).toBeGreaterThan(0); // still lands near the wander zero-crossings
  });

  it("moves adjacent hipfire samples as a coherent sweep instead of orbit-jumping", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, voltaicLoadout as never);
    const shooter = makeShooter(0, 0);
    const directions: Array<{ x: number; y: number; z: number }> = [];

    for (let tick = 1; tick <= 120; tick++) {
      sys.update(makeState([shooter]) as never, 1 / 125, tick as never);
      for (const beam of sys.getPendingVoltaicBeamEvents()) {
        directions.push({ x: beam.dirX, y: beam.dirY, z: beam.dirZ });
      }
    }

    expect(directions.length).toBeGreaterThan(10);
    let maximumStep = 0;
    for (let index = 1; index < directions.length; index++) {
      const previous = directions[index - 1];
      const current = directions[index];
      const dot = Math.max(-1, Math.min(1, previous.x * current.x + previous.y * current.y + previous.z * current.z));
      maximumStep = Math.max(maximumStep, Math.acos(dot));
    }

    expect(maximumStep).toBeLessThan((0.75 * Math.PI) / 180);
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
    sys.update(makeState([shooter]) as never, 1 / 125, 80 as never);
    shooter.input.buttons = FIRE_BUTTON | (1 << 9);
    sys.update(makeState([shooter]) as never, 1 / 125, 100 as never);

    expect(registeredDefId).toBe("rocket");
  });

  it("firing glauncher registers the grenade projectile definition ballistics", () => {
    const sys = new WeaponSystem();
    let registeredDefId = "";
    let registeredOpts: Record<string, unknown> | undefined;
    let spawnedProjectile: { physics?: { velocity?: { z?: number } } } | undefined;
    sys.setProjectileSystem({
      registerProjectileType: (_id: unknown, defId: string, opts: Record<string, unknown>) => {
        registeredDefId = defId;
        registeredOpts = opts;
      },
    } as never);
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["glauncher"], ammo: { glauncher: 5 }, health: 100, armor: 0 } as never,
    );

    const shooter = makeShooter(0, 0);
    const state = {
      ...makeState([shooter]),
      addEntity: (entity: { physics?: { velocity?: { z?: number } } }) => {
        spawnedProjectile = entity;
      },
    };

    shooter.input.buttons = 1 << 9; // hold ADS first to bypass glauncher's hipfireBlocked delay
    sys.update(state as never, 1 / 125, 80 as never);
    shooter.input.buttons = FIRE_BUTTON | (1 << 9);
    sys.update(state as never, 1 / 125, 100 as never);

    expect(GRENADE_LAUNCHER.projectileId).toBe(GRENADE.id);
    expect(GRENADE_LAUNCHER.projectileSpeed).toBe(GRENADE.speed);
    expect(GRENADE_LAUNCHER.projectileGravity).toBe(GRENADE.gravity);
    expect(registeredDefId).toBe(GRENADE.id);
    expect(registeredOpts).toMatchObject({
      bounces: GRENADE.bounces,
      lifetime: GRENADE.lifetime,
      gravity: GRENADE.gravity,
      bounceFactor: GRENADE.bounceFactor,
    });
    expect(spawnedProjectile?.physics?.velocity?.z).toBeCloseTo(GRENADE.speed, 6);
  });
});
describe("WeaponSystem - ammo type pickups", () => {
  it("adds ammo to owned weapons by ammo type and caps at max ammo", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["rlauncher"], ammo: { rlauncher: 0 }, health: 100, armor: 0 } as never,
    );

    expect(sys.addAmmoByType(1 as never, "rockets", 10)).toBe(true);
    expect(sys.getAmmo(1 as never, "rlauncher")).toBe(10);

    expect(sys.addAmmoByType(1 as never, "rockets", 99)).toBe(true);
    expect(sys.getAmmo(1 as never, "rlauncher")).toBe(20);

    expect(sys.addAmmoByType(1 as never, "rockets", 1)).toBe(false);
    expect(sys.addAmmoByType(1 as never, "cells", 10)).toBe(false);
  });
});
describe("WeaponSystem - WO-AC1 single-ray hitscan accuracy", () => {
  it("counts a shot per trigger pull and a hit when the ray lands", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);
    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, TARGET_DISTANCE);

    sys.update(makeState([shooter, target]) as never, 1 / 125, 100 as never);

    const acc = sys.getAccuracy(1 as never);
    expect(acc.shots).toBe(1);
    expect(acc.hits).toBe(1);
    expect(acc.headshots).toBe(0); // body hit along the level ray
  });

  it("counts a shot but no hit on a miss, and accumulates across shots", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);
    const shooter = makeShooter(0, 0);
    const target = makeTargetAlongRay(0, 0, TARGET_DISTANCE);
    const interval = fireIntervalTicks({ fireRate: 10 });

    // shot 1: hit
    sys.update(makeState([shooter, target]) as never, 1 / 125, interval as never);
    // shot 2: no target in the world → miss
    sys.update(makeState([shooter]) as never, 1 / 125, (interval * 2) as never);

    const acc = sys.getAccuracy(1 as never);
    expect(acc.shots).toBe(2);
    expect(acc.hits).toBe(1);
  });

  it("reports zero accuracy for an entity that never fired", () => {
    const sys = new WeaponSystem();
    expect(sys.getAccuracy(99 as never)).toEqual({ shots: 0, hits: 0, headshots: 0 });
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

describe("WeaponSystem - blade charge ends with the blade", () => {
  const ALT_FIRE_BUTTON = 1 << 9;
  function charging() {
    const sys = new WeaponSystem();
    sys.setMovementSubsystem({ setSpeedBonus: vi.fn(), queueMeleeDash: vi.fn() } as never);
    const shooter = {
      id: 1,
      ownerId: 1,
      transform: { position: { x: 0, y: 0, z: 0 } },
      input: { buttons: ALT_FIRE_BUTTON, yaw: 0, pitch: 0, weaponSlot: 0 },
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
    const state = makeState([shooter]);
    sys.initializeWeaponFromLoadout(
      1 as never,
      { weapons: ["blade", "machinegun"], ammo: { blade: 1, machinegun: 160 }, health: 100, armor: 0 } as never,
    );
    sys.update(state as never, 1 / 125, 100 as never);
    expect(sys.getPendingChargeEvents()).toEqual([expect.objectContaining({ charging: true })]);
    return { sys, shooter, state };
  }

  // Ended silently, others kept the charger's glow, back on them after respawn,
  // and the charger's own client skipped its next blade slash (L5).
  it("tells everyone the charge stopped when the player switches away", () => {
    const { sys, shooter, state } = charging();
    shooter.input.buttons = 0;
    shooter.input.weaponSlot = 2;
    sys.update(state as never, 1 / 125, 101 as never);
    expect(sys.getPendingChargeEvents()).toEqual([
      expect.objectContaining({ entityId: 1, weaponId: "blade", charging: false }),
    ]);
  });

  it("tells everyone the charge stopped when the player dies, once", () => {
    const { sys, shooter, state } = charging();
    shooter.health.dead = true;
    sys.update(state as never, 1 / 125, 101 as never);
    sys.update(state as never, 1 / 125, 102 as never);
    expect(sys.getPendingChargeEvents()).toEqual([expect.objectContaining({ charging: false })]);

    // Alt still held at respawn starts a new charge; it does not fire the old one.
    shooter.health.dead = false;
    sys.update(state as never, 1 / 125, 300 as never);
    expect(sys.getPendingChargeEvents()).toEqual([expect.objectContaining({ charging: true })]);
  });
});

describe("WeaponSystem — lag-compensated hit registration", () => {
  const stateAt = (tick: number, entities: unknown[]) => ({ ...makeState(entities), tick });
  /** A shooter that reports the snapshot tick it was aiming with. */
  const shooterViewing = (viewTick: number) => {
    const s = makeShooter(0, 0);
    (s.input as { viewTick?: number }).viewTick = viewTick;
    return s;
  };
  const withHistory = (recorded: unknown[]) => {
    const lag = new LagCompensation({ ...LAG_COMPENSATION, tickRate: 125 });
    for (let tick = 80; tick < 100; tick++) lag.recordPositions(stateAt(tick, recorded) as never);
    const sys = new WeaponSystem();
    sys.setLagCompensation(lag);
    sys.initializeWeaponFromLoadout(1 as never, mgLoadout as never);
    return sys;
  };

  it("judges a shot against the snapshot the shooter reported aiming with", () => {
    const onRay = makeTargetAlongRay(0, 0, TARGET_DISTANCE);
    const movedAway = {
      ...onRay,
      transform: { position: { ...onRay.transform.position, x: onRay.transform.position.x + 500 } },
    };

    // Control: no history, so the shot is judged against the present and a
    // target that has since stepped aside is missed.
    const plain = new WeaponSystem();
    plain.initializeWeaponFromLoadout(1 as never, mgLoadout as never);
    plain.update(stateAt(100, [shooterViewing(95), movedAway]) as never, 1 / 125, 100 as never);
    expect(plain.getPendingDamage()).toHaveLength(0);

    // Same shot, with the server remembering where that snapshot put the target.
    const sys = withHistory([makeShooter(0, 0), onRay]);
    sys.update(stateAt(100, [shooterViewing(95), movedAway]) as never, 1 / 125, 100 as never);
    expect(sys.getPendingDamage().map((d) => d.victimId)).toContain(2);
  });

  it("does not rewind a shooter that reports no view tick", () => {
    // Bots and pre-first-snapshot clients have no latency to compensate.
    const onRay = makeTargetAlongRay(0, 0, TARGET_DISTANCE);
    const movedAway = {
      ...onRay,
      transform: { position: { ...onRay.transform.position, x: onRay.transform.position.x + 500 } },
    };
    const sys = withHistory([makeShooter(0, 0), onRay]);
    sys.update(stateAt(100, [shooterViewing(0), movedAway]) as never, 1 / 125, 100 as never);
    expect(sys.getPendingDamage()).toHaveLength(0);
  });

  it("clamps a view tick claiming the distant past to the compensation budget", () => {
    // Asking to be judged against tick 1 must not reach past the oldest
    // recorded state; it gets the budget's edge and nothing more.
    const onRay = makeTargetAlongRay(0, 0, TARGET_DISTANCE);
    const movedAway = {
      ...onRay,
      transform: { position: { ...onRay.transform.position, x: onRay.transform.position.x + 500 } },
    };
    const sys = withHistory([makeShooter(0, 0), onRay]);
    sys.update(stateAt(100, [shooterViewing(1), movedAway]) as never, 1 / 125, 100 as never);
    // Still resolves against recorded history rather than throwing or snapping
    // to the present — the clamp lands inside the 100ms window.
    expect(sys.getPendingDamage().map((d) => d.victimId)).toContain(2);
  });

  it("does not invent hits on a target that was never on the ray", () => {
    const offRay = makeTargetAlongRay(0, 0, TARGET_DISTANCE);
    offRay.transform.position.x += 500;
    const sys = withHistory([makeShooter(0, 0), offRay]);
    sys.update(stateAt(100, [shooterViewing(95), offRay]) as never, 1 / 125, 100 as never);
    expect(sys.getPendingDamage()).toHaveLength(0);
  });

  it("falls back to the present for a target with no recorded history", () => {
    const onRay = makeTargetAlongRay(0, 0, TARGET_DISTANCE);
    // History exists, but this target only just spawned into it.
    const sys = withHistory([makeShooter(0, 0)]);
    sys.update(stateAt(100, [shooterViewing(95), onRay]) as never, 1 / 125, 100 as never);
    expect(sys.getPendingDamage().map((d) => d.victimId)).toContain(2);
  });
});
