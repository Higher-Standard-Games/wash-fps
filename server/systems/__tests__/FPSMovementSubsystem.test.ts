import { EntityType } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
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