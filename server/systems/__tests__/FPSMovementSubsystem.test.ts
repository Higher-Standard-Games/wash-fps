import { EntityType } from "@engine/server/ecs/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FPSMovementSubsystem } from "../FPSMovementSubsystem";

function makePlayer() {
  return {
    id: 1,
    ownerId: 1,
    transform: { position: { x: 0, y: 64, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    physics: {
      velocity: { x: 0, y: 0, z: 0 },
      grounded: true,
      isSliding: false,
      isCrouching: false,
      crouchViewOffset: 0,
      wallJumpState: "none",
      ledgeGrabState: "none",
      actualHorizSpeed: 0,
    },
    input: {
      forward: 0,
      right: 0,
      pitch: 0,
      yaw: 0,
      buttons: 0,
      weaponSlot: 0,
      inputQueue: [],
      sequence: 1,
      lastProcessedSeq: 0,
    },
    health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    spawnTick: 0,
  };
}

function makeState(player: ReturnType<typeof makePlayer>) {
  return {
    entitiesByType: (t: EntityType) => (t === EntityType.Player ? [player] : []),
    getEntityMut: (id: number) => (id === player.id ? player : undefined),
  };
}

describe("FPSMovementSubsystem - melee dash", () => {
  it("applies a queued horizontal dash on the next movement tick", () => {
    const player = makePlayer();
    const subsystem = new FPSMovementSubsystem();

    subsystem.queueMeleeDash({ entityId: 1 as never, dirX: 0, dirZ: 1, distance: 48 });
    subsystem.update(makeState(player) as never, 1 / 125, 1 as never);

    expect(player.transform.position.x).toBeCloseTo(0, 6);
    expect(player.transform.position.z).toBeCloseTo(48, 6);
  });

  it("clamps the dash against collision traces", () => {
    const player = makePlayer();
    const collisionWorld = {
      trace: () => ({ hit: true, fraction: 0.5 }),
      stepSlideMove: (_start: unknown, velocity: unknown) => ({
        endPos: player.transform.position,
        velocity,
        grounded: true,
      }),
      pointContents: () => 0,
      findEntitiesInRadius: () => [],
      getWorldBounds: () => ({ min: { x: -999, y: -999, z: -999 }, max: { x: 999, y: 999, z: 999 } }),
    };
    const subsystem = new FPSMovementSubsystem(collisionWorld as never);

    subsystem.queueMeleeDash({ entityId: 1 as never, dirX: 1, dirZ: 0, distance: 48 });
    subsystem.update(makeState(player) as never, 1 / 125, 1 as never);

    expect(player.transform.position.x).toBeCloseTo(48 * 0.48, 6);
    expect(player.transform.position.z).toBeCloseTo(0, 6);
  });
});

// ── WO-T3: teleporter server side effects ──────────────────────────

/** Fake movement profile whose simulate() returns a scripted result. */
function fakeProfile(result: Partial<Record<string, unknown>>) {
  return {
    speedBonus: 0,
    resetPhysicsState: () => {},
    setTriggerVolumes: () => {},
    simulate: (_pos: unknown, velocity: { x: number; y: number; z: number }) => ({
      position: { x: 0, y: 64, z: 0 },
      velocity,
      grounded: false,
      isSliding: false,
      isCrouching: false,
      crouchViewOffset: 0,
      wallJumpState: "none",
      ledgeGrabState: "none",
      actualHorizSpeed: 0,
      slidePhase: 0,
      ledgeGrabPhase: 0,
      ...result,
    }),
  };
}

function makeTwoPlayerState(p1: ReturnType<typeof makePlayer>, p2: ReturnType<typeof makePlayer>) {
  return {
    entitiesByType: (t: EntityType) => (t === EntityType.Player ? [p1, p2] : []),
    getEntityMut: (id: number) => (id === p1.id ? p1 : id === p2.id ? p2 : undefined),
  };
}

describe("FPSMovementSubsystem - teleporter side effects (WO-T3)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("telefrags a living player occupying the teleporter exit (frag credited to the teleporter)", () => {
    const p1 = makePlayer();
    const p2 = { ...makePlayer(), id: 2, ownerId: 2 };
    p2.transform = { position: { x: 110, y: 25, z: 90 }, rotation: { x: 0, y: 0, z: 0 } };
    p2.input = { ...p1.input, inputQueue: [] };
    p2.physics = { ...p1.physics, velocity: { x: 0, y: 0, z: 0 } };

    const subsystem = new FPSMovementSubsystem();
    const queueDamage = vi.fn();
    subsystem.setCombatSystem({ queueDamage, setMovementSubsystem: () => {} } as never);
    // biome-ignore lint/suspicious/noExplicitAny: inject scripted profile for p1
    (subsystem as any).movementProfiles.set(1, fakeProfile({ teleported: true, position: { x: 100, y: 25, z: 100 } }));

    subsystem.update(makeTwoPlayerState(p1, p2) as never, 1 / 125, 1 as never);

    expect(queueDamage).toHaveBeenCalledTimes(1);
    expect(queueDamage.mock.calls[0][0]).toMatchObject({
      victimId: 2,
      attackerId: 1,
      damage: 9999,
      armorPiercing: 1,
      damageType: "telefrag",
    });
  });

  it("does not telefrag players outside the exit box, dead players, or the teleporter itself", () => {
    const p1 = makePlayer();
    const far = { ...makePlayer(), id: 2, ownerId: 2 };
    far.transform = { position: { x: 200, y: 25, z: 100 }, rotation: { x: 0, y: 0, z: 0 } }; // 100u away
    const dead = { ...makePlayer(), id: 3, ownerId: 3 };
    dead.transform = { position: { x: 100, y: 25, z: 100 }, rotation: { x: 0, y: 0, z: 0 } };
    dead.health = { ...dead.health, dead: true };

    const subsystem = new FPSMovementSubsystem();
    const queueDamage = vi.fn();
    subsystem.setCombatSystem({ queueDamage, setMovementSubsystem: () => {} } as never);
    // biome-ignore lint/suspicious/noExplicitAny: inject scripted profile for p1
    (subsystem as any).movementProfiles.set(1, fakeProfile({ teleported: true, position: { x: 100, y: 25, z: 100 } }));

    const state = {
      entitiesByType: (t: EntityType) => (t === EntityType.Player ? [p1, far, dead] : []),
      getEntityMut: () => undefined,
    };
    subsystem.update(state as never, 1 / 125, 1 as never);

    expect(queueDamage).not.toHaveBeenCalled();
  });

  it("whitelists teleport ticks from the position-delta tripwire (but not plain warps)", () => {
    // Teleported: a ~700u jump must NOT trip the [Authority] warning.
    const teleported = makePlayer();
    teleported.transform.position = { x: 500, y: 64, z: 500 };
    const sub1 = new FPSMovementSubsystem();
    // biome-ignore lint/suspicious/noExplicitAny: inject scripted profile
    (sub1 as any).movementProfiles.set(1, fakeProfile({ teleported: true, position: { x: 0, y: 64, z: 0 } }));
    sub1.update(makeState(teleported) as never, 1 / 125, 1 as never);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("[Authority]"));

    // Same jump WITHOUT the teleported flag: tripwire must still fire.
    const warped = makePlayer();
    warped.transform.position = { x: 500, y: 64, z: 500 };
    const sub2 = new FPSMovementSubsystem();
    // biome-ignore lint/suspicious/noExplicitAny: inject scripted profile
    (sub2 as any).movementProfiles.set(1, fakeProfile({ position: { x: 0, y: 64, z: 0 } }));
    sub2.update(makeState(warped) as never, 1 / 125, 1 as never);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[Authority]"));
  });
});