import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MovementVars } from "../../../../engine/movement/MovementVars";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import { Simulation } from "../../../../engine/server/core/Simulation";
import { createPlayerEntity } from "../../../../engine/server/ecs/Entity";
import { entityId, playerId } from "../../../../engine/server/ecs/types";
import type { QueuedInput } from "../../../../shared/server/simulation/components/InputComponent";
import { CombatSystem, DamageType } from "../systems/CombatSystem";
import { FPSMovementSubsystem } from "../systems/FPSMovementSubsystem";

function cmd(seq: number, buttons = 0): QueuedInput {
  return { forward: 0, right: 0, pitch: 0, yaw: 0, buttons, sequence: seq, weaponSlot: 0 };
}

/**
 * Drives one player through a scripted grounded/airborne sequence.
 * Each entry = one tick: { y, grounded }. Fall tracking arms on the first
 * grounded tick after spawn, so damage sequences must start grounded.
 */
function makeScriptedSim(
  steps: Array<{ y: number; grounded: boolean; teleported?: boolean }>,
  buttons = 0,
  health = 100,
  armor = 0,
) {
  const sim = new Simulation({ tickMs: 8 });
  const movement = new FPSMovementSubsystem();
  const combat = new CombatSystem();
  combat.setMovementSubsystem(movement);
  movement.setCombatSystem(combat);
  sim.addSubsystem(movement);
  sim.addSubsystem(combat);
  sim.initialize();

  const id = entityId(1);
  const state = sim.getStateMut();
  state.addEntity(createPlayerEntity(id, playerId(1), { x: 0, y: 0, z: 0 }));
  const player = state.getEntityMut(id)!;
  player.health!.health = health;
  player.health!.armor = armor;
  player.input!.inputQueue.push(...steps.map((_, i) => cmd(i + 1, buttons)));

  let step = -1;
  // biome-ignore lint/suspicious/noExplicitAny: inject a tiny deterministic movement profile for band tests.
  (movement as any).movementProfiles.set(id as unknown as number, {
    speedBonus: 0,
    resetPhysicsState: () => {},
    simulate: (_position: unknown, velocity: { x: number; y: number; z: number }) => {
      step = Math.min(step + 1, steps.length - 1);
      const s = steps[step];
      return {
        position: { x: 0, y: s.y, z: 0 },
        velocity: { ...velocity, y: s.grounded ? 0 : -100 },
        grounded: s.grounded,
        isSliding: false,
        isCrouching: (buttons & InputButtons.CROUCH) !== 0,
        crouchViewOffset: 0,
        wallJumpState: "none",
        ledgeGrabState: "none",
        actualHorizSpeed: 0,
        teleported: s.teleported ?? false,
      };
    },
  });

  for (let i = 0; i < steps.length; i++) sim.tick();

  return { entity: sim.getStateMut().getEntity(id)!, combat };
}

/** Standard fall: grounded at ledge height -> airborne -> land at 0. */
function makeFallSim(drop: number, buttons = 0, health = 100, armor = 0) {
  return makeScriptedSim(
    [
      { y: drop, grounded: true },
      { y: drop, grounded: false },
      { y: 0, grounded: true },
    ],
    buttons,
    health,
    armor,
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  MovementVars.getInstance().resetAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server fall damage", () => {
  it("does not damage drops below the minimum threshold", () => {
    const { entity } = makeFallSim(248, 0, 100, 50);

    expect(entity.health!.health).toBe(100);
    expect(entity.health!.armor).toBe(50);
    expect(entity.health!.dead).toBe(false);
  });

  it("does not count a jump arc as extra fall distance", () => {
    const { entity } = makeScriptedSim(
      [
        { y: 200, grounded: true },
        { y: 300, grounded: false },
        { y: 0, grounded: true },
      ],
      0,
      100,
      0,
    );

    expect(entity.health!.health).toBe(100);
    expect(entity.health!.dead).toBe(false);
  });

  it("ramps 256u to 384u falls through normal armor absorption", () => {
    const { entity } = makeFallSim(320, 0, 100, 50);

    expect(entity.health!.health).toBeCloseTo(83, 1);
    expect(entity.health!.armor).toBeCloseTo(17, 1);
    expect(entity.health!.dead).toBe(false);
  });

  it("crush-band falls leave the player at exactly 1 health and 0 armor", () => {
    const { entity } = makeFallSim(428, 0, 100, 200);

    expect(entity.health!.health).toBe(1);
    expect(entity.health!.armor).toBe(0);
    expect(entity.health!.dead).toBe(false);
  });

  it("fatal falls self-frag through armor", () => {
    const { entity, combat } = makeFallSim(512, 0, 100, 200);
    const [kill] = combat.getRecentKills();

    expect(entity.health!.health).toBe(0);
    expect(entity.health!.dead).toBe(true);
    expect(kill).toMatchObject({ victimId: entityId(1), killerId: entityId(1), damageType: DamageType.Fall });
  });

  it("sv_falldamage disables all fall damage", () => {
    MovementVars.getInstance().set("sv_falldamage", 0);
    const { entity } = makeFallSim(500, 0, 100, 200);

    expect(entity.health!.health).toBe(100);
    expect(entity.health!.armor).toBe(200);
    expect(entity.health!.dead).toBe(false);
  });

  it("holding crouch on landing softens the effective drop", () => {
    const normal = makeFallSim(428, 0, 100, 0).entity;
    const crouched = makeFallSim(428, InputButtons.CROUCH, 100, 0).entity;

    expect(normal.health!.health).toBe(1);
    expect(crouched.health!.health).toBeGreaterThan(1);
    expect(crouched.health!.dead).toBe(false);
  });

  it("teleporting mid-fall clears fall tracking — the drop restarts from the exit (WO-T3)", () => {
    // Fall from 600u, teleport near the floor mid-fall, land: without the
    // teleport-clears-tracking rule this measures a 600u fatal drop.
    const { entity } = makeScriptedSim(
      [
        { y: 600, grounded: true }, // standing high (arms tracking)
        { y: 600, grounded: false }, // falling
        { y: 400, grounded: false }, // still falling
        { y: 25, grounded: false, teleported: true }, // teleporter exit near floor
        { y: 0, grounded: true }, // land: 25u from the exit — harmless
      ],
      0,
      100,
      0,
    );

    expect(entity.health!.health).toBe(100);
    expect(entity.health!.dead).toBe(false);
  });

  it("does not damage the post-spawn drop (tracking arms on first grounded tick)", () => {
    // Spawned airborne at 500u (elevated spawn pad) - first landing is free,
    // but a subsequent fall from the same height damages normally.
    const { entity } = makeScriptedSim(
      [
        { y: 500, grounded: false }, // spawn drop - unarmed, no tracking
        { y: 0, grounded: true }, // first landing: arms tracking, no damage
        { y: 320, grounded: true }, // later standing on a high ledge
        { y: 320, grounded: false }, // real fall afterwards
        { y: 0, grounded: true }, // ramp-band landing -> damage
      ],
      0,
      100,
      0,
    );

    expect(entity.health!.dead).toBe(false);
    expect(entity.health!.health).toBeLessThan(100); // second fall damaged
    expect(entity.health!.health).toBeGreaterThan(1); // but spawn drop did not kill
  });
});
