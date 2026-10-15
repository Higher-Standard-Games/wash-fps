import { EntityType } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { InputButtons } from "../../../../../engine/network/components/InputComponent";
import { MessageCodec } from "../../../../../engine/network/protocol/MessageCodec";
import { ELECTROBOLT } from "../../../../../shared/entities/definitions/weapons/electrobolt";
import { GRENADE_LAUNCHER } from "../../../../../shared/entities/definitions/weapons/glauncher";
import { PLASMAGUN } from "../../../../../shared/entities/definitions/weapons/plasmagun";
import { ROCKET_LAUNCHER } from "../../../../../shared/entities/definitions/weapons/rlauncher";
import { WEAPONS } from "../../../../../shared/entities/definitions/weapons/WeaponsTable";
import { fireIntervalTicks, WeaponSystem } from "../WeaponSystem";

const { FIRE, ALT_FIRE, AUTO_ADS } = InputButtons;
function setup(weapon: string) {
  const sys = new WeaponSystem();
  sys.initializeWeaponFromLoadout(
    1 as never,
    { weapons: [weapon], ammo: { [weapon]: 10 }, health: 100, armor: 0 } as never,
  );
  const shooter = {
    id: 1,
    ownerId: 1,
    transform: { position: { x: 0, y: 0, z: 0 } },
    input: { buttons: 0, yaw: 0, pitch: 0, weaponSlot: 0 },
    health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
  };
  const projectiles: Array<{ physics: { velocity: { x: number; y: number; z: number } } }> = [];
  const state = {
    entitiesByType: (type: EntityType) => (type === EntityType.Player ? [shooter] : []),
    getEntity: () => shooter,
    getEntityMut: () => shooter,
    addEntity: (entity: (typeof projectiles)[number]) => projectiles.push(entity),
    removeEntity: () => {},
  };
  const step = (tick: number, buttons: number) => {
    shooter.input.buttons = buttons;
    sys.update(state as never, 1 / 125, tick as never);
    return sys.getPendingFireEvents();
  };
  return { sys, step, shooter, projectiles };
}
const angle = (fire: { dirZ: number }) => (Math.acos(Math.min(1, fire.dirZ)) * 180) / Math.PI;

it("reserves primary-fire automatic ADS for RL and GL", () => {
  const automatic = [
    ...new Set(
      Object.values(WEAPONS)
        .filter((weapon) => weapon.hipfireBlocked)
        .map((weapon) => weapon.id),
    ),
  ];
  expect(automatic.sort()).toEqual(["glauncher", "rlauncher"]);
});

it("fires plasma instantly from the hip with spread and keeps manual ADS accurate", () => {
  const hip = setup("plasmagun");
  expect(hip.step(1000, FIRE)).toHaveLength(1);
  expect(hip.projectiles).toHaveLength(1);
  const velocity = hip.projectiles[0].physics.velocity;
  expect(Math.hypot(velocity.x, velocity.y)).toBeGreaterThan(0);
  expect(angle({ dirZ: velocity.z / Math.hypot(velocity.x, velocity.y, velocity.z) })).toBeLessThanOrEqual(
    PLASMAGUN.spread!,
  );
  expect(hip.step(1000 + fireIntervalTicks(PLASMAGUN), FIRE)).toHaveLength(1);

  const aimed = setup("plasmagun");
  expect(aimed.step(1000, FIRE | ALT_FIRE)).toHaveLength(1);
  const aimedVelocity = aimed.projectiles[0].physics.velocity;
  expect(aimedVelocity.x).toBeCloseTo(0);
  expect(aimedVelocity.y).toBeCloseTo(0);
  expect(aimedVelocity.z).toBe(PLASMAGUN.projectileSpeed);
});

describe.each([ROCKET_LAUNCHER, GRENADE_LAUNCHER])("$id ADS gate", (weapon) => {
  const delay = Math.ceil(weapon.ads!.time * 125);
  it("waits the whole ADS time and retains spread on automatic aim", () => {
    const { step, sys, projectiles } = setup(weapon.id);
    const buttons = FIRE | ALT_FIRE | AUTO_ADS;
    for (let tick = 1000; tick < 1000 + delay; tick++) expect(step(tick, buttons)).toHaveLength(0);
    expect(sys.getWeaponState(1 as never)!.ammo.get(weapon.id)!.clip).toBe(10);
    const [fire] = step(1000 + delay, buttons);
    expect(fire).toBeDefined();
    expect(angle(fire)).toBeGreaterThan(0);
    expect(angle(fire)).toBeLessThanOrEqual(weapon.spread! + 1e-6);
    const v = projectiles[0].physics.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    expect(v.x / speed).toBeCloseTo(fire.dirX, 12);
    expect(v.y / speed).toBeCloseTo(fire.dirY, 12);
    expect(v.z / speed).toBeCloseTo(fire.dirZ, 12);
  });
  it("cancels on release and starts a fresh delay on the next pull", () => {
    const { step } = setup(weapon.id);
    step(1000, FIRE | ALT_FIRE | AUTO_ADS);
    expect(step(1003, 0)).toHaveLength(0);
    expect(step(1100, FIRE | ALT_FIRE | AUTO_ADS)).toHaveLength(0);
    expect(step(1100 + delay - 1, FIRE | ALT_FIRE | AUTO_ADS)).toHaveLength(0);
    expect(step(1100 + delay, FIRE | ALT_FIRE | AUTO_ADS)).toHaveLength(1);
  });
  it("waits out partial manual ADS and then fires straight", () => {
    const { step } = setup(weapon.id);
    step(1000, ALT_FIRE);
    expect(step(1001, FIRE | ALT_FIRE)).toHaveLength(0);
    expect(step(1000 + delay - 1, FIRE | ALT_FIRE)).toHaveLength(0);
    const [fire] = step(1000 + delay, FIRE | ALT_FIRE);
    expect([fire.dirX, fire.dirY, fire.dirZ]).toEqual([0, 0, 1]);
  });
  it("fires immediately when manual ADS was already complete", () => {
    const { step } = setup(weapon.id);
    step(1000, ALT_FIRE);
    const [fire] = step(1100, FIRE | ALT_FIRE);
    expect([fire.dirX, fire.dirY, fire.dirZ]).toEqual([0, 0, 1]);
  });
  it("does not inherit aim readiness across death", () => {
    const { step, shooter } = setup(weapon.id);
    step(1000, ALT_FIRE);
    shooter.health.dead = true;
    step(1050, ALT_FIRE);
    shooter.health.dead = false;
    expect(step(1100, FIRE | ALT_FIRE | AUTO_ADS)).toHaveLength(0);
  });
  it("handles a raise beginning at tick zero", () => {
    const { step, sys } = setup(weapon.id);
    sys.getWeaponState(1 as never)!.lastFireTick = -1000;
    expect(step(0, FIRE | ALT_FIRE | AUTO_ADS)).toHaveLength(0);
    expect(step(delay - 1, FIRE | ALT_FIRE | AUTO_ADS)).toHaveLength(0);
    expect(step(delay, FIRE | ALT_FIRE | AUTO_ADS)).toHaveLength(1);
  });
});

it("fires EB hipfire instantly with wide deterministic spread, and complete manual ADS straight", () => {
  const hip = setup("electrobolt");
  const repeat = setup("electrobolt");
  const [first] = hip.step(1000, FIRE);
  expect(first).toEqual(repeat.step(1000, FIRE)[0]);
  expect(angle(first)).toBeGreaterThan(1);
  expect(angle(first)).toBeLessThanOrEqual(ELECTROBOLT.spread!);
  const aimed = setup("electrobolt");
  aimed.step(1000, ALT_FIRE);
  const delay = Math.ceil(ELECTROBOLT.ads!.time / 0.008);
  expect(ELECTROBOLT.ads!.time).toBe(0.375);
  const [manual] = aimed.step(1000 + delay, FIRE | ALT_FIRE);
  expect([manual.dirX, manual.dirY, manual.dirZ]).toEqual([0, 0, 1]);
  const partial = setup("electrobolt");
  partial.step(1000, ALT_FIRE);
  expect(angle(partial.step(1000 + delay - 1, FIRE | ALT_FIRE)[0])).toBeGreaterThan(0);
  expect(hip.step(1000 + fireIntervalTicks(ELECTROBOLT), FIRE)).toHaveLength(1);
});

it("preserves the automatic ADS marker in the existing command packet", () => {
  const buttons = FIRE | ALT_FIRE | AUTO_ADS;
  const wire = MessageCodec.encodeCommand("player_1", 3, { buttons, tick: 10, pitch: 0, yaw: 0 });
  expect(MessageCodec.decodeCommand(wire).command.buttons).toBe(buttons);
  const manual = MessageCodec.encodeCommand("player_1", 3, { buttons: FIRE | ALT_FIRE, tick: 10, pitch: 0, yaw: 0 });
  expect(MessageCodec.decodeCommand(manual).command.buttons).toBe(FIRE | ALT_FIRE);
  expect(manual).toHaveLength(wire.length);
});
