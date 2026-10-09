/**
 * WeaponSystem — what happens on the ticks AFTER the server changes the weapon
 * in your hands, driven through a real Simulation so `update()` runs.
 *
 * The server keeps the last weapon slot a player pressed (`input.weaponSlot`
 * is only overwritten by a new press, and respawn sets it to 1), and switches
 * on a CHANGE of that value. Each case here is a way a server-made switch or a
 * switch held over from the previous weapon used to leak into the next tick.
 */

import { Simulation } from "@engine/server/core/Simulation";
import { createPlayerEntity } from "@engine/server/ecs/Entity";
import { entityId, playerId } from "@engine/server/ecs/types";
import { describe, expect, it, vi } from "vitest";
import { WeaponSystem } from "../WeaponSystem";

const ENTITY = entityId(1);
const ALT_FIRE = 1 << 9;

function world(weapons: string[]) {
  const sim = new Simulation({ tickMs: 8 });
  const system = new WeaponSystem();
  sim.addSubsystem(system);
  sim.initialize();
  const state = sim.getStateMut();
  state.addEntity(createPlayerEntity(ENTITY, playerId(1), { x: 0, y: 0, z: 0 }));
  system.initializeWeaponFromLoadout(ENTITY, {
    weapons,
    ammo: { blade: 1, machinegun: 160, riotgun: 32 },
    health: 100,
    armor: 0,
  } as never);
  const input = () => {
    const entityInput = state.getEntityMut(ENTITY)?.input;
    if (!entityInput) throw new Error("player has no input");
    return entityInput;
  };
  // Respawn leaves slot 1 as the last one pressed; let a few ticks settle on it.
  input().weaponSlot = 1;
  for (let i = 0; i < 40; i++) sim.tick();
  const held = () => system.getWeaponState(ENTITY)?.currentWeapon;
  return { sim, system, input, held };
}

describe("after a pickup switches your weapon", () => {
  it("keeps the new weapon on the following ticks", () => {
    const { sim, system, held } = world(["blade"]);
    system.addWeapon(ENTITY, "machinegun");
    for (let i = 0; i < 5; i++) sim.tick();
    expect(held()).toBe("machinegun");
  });

  it("keeps an already-owned gun it armed you with", () => {
    const { sim, system, held } = world(["blade", "machinegun"]);
    system.addWeapon(ENTITY, "machinegun");
    for (let i = 0; i < 5; i++) sim.tick();
    expect(held()).toBe("machinegun");
  });

  it("still switches back when you press the slot you pressed before the pickup", () => {
    const { sim, system, input, held } = world(["blade"]);
    system.addWeapon(ENTITY, "machinegun");
    sim.tick();
    input().weaponSlot = 1; // a fresh press of the same key
    sim.tick();
    expect(held()).toBe("blade");
  });

  it("does not hold up your next switch with the manual switch delay", () => {
    const { sim, system, input, held } = world(["blade", "riotgun"]);
    system.addWeapon(ENTITY, "machinegun");
    sim.tick();
    input().weaponSlot = 2;
    sim.tick();
    expect(held()).toBe("riotgun");
  });

  it("cancels the old weapon's reload instead of handing it to the new one", () => {
    const { sim, system, held } = world(["blade", "machinegun"]);
    const weapons = system.getWeaponState(ENTITY);
    if (!weapons) throw new Error("no weapon state");
    weapons.currentWeapon = "machinegun";
    weapons.reloading = true;
    weapons.reloadEndTick = sim.currentTick + 500;
    system.addWeapon(ENTITY, "riotgun");
    sim.tick();
    expect(held()).toBe("riotgun");
    expect(weapons.reloading).toBe(false);
  });
});

describe("the blade's charged attack", () => {
  it("does not fire a full charge when alt-fire was held through the switch", () => {
    const { sim, system, input, held } = world(["blade", "machinegun"]);
    const charged = vi.fn();
    (system as unknown as { fireChargedProjectile: typeof charged }).fireChargedProjectile = charged;

    input().weaponSlot = 2;
    input().buttons = ALT_FIRE;
    for (let i = 0; i < 300; i++) sim.tick(); // holding alt-fire on the machinegun
    input().weaponSlot = 1;
    sim.tick();
    expect(held()).toBe("blade");
    input().buttons = 0;
    sim.tick();

    // Held for one tick on the blade, which is under the minimum charge.
    expect(charged).not.toHaveBeenCalled();
  });

  it("charges from the moment the blade is in hand when alt-fire stays held", () => {
    const { sim, system, input } = world(["blade", "machinegun"]);
    const charged = vi.fn();
    (system as unknown as { fireChargedProjectile: typeof charged }).fireChargedProjectile = charged;
    const events = () => system.getPendingChargeEvents();

    input().weaponSlot = 2;
    input().buttons = ALT_FIRE;
    for (let i = 0; i < 50; i++) sim.tick();
    events();
    input().weaponSlot = 1;
    sim.tick();
    sim.tick();
    // The charge-up other players see starts on the blade, as a fresh press would.
    expect(events()).toContainEqual(expect.objectContaining({ entityId: ENTITY, charging: true }));
  });
});

describe("an entity leaving the world", () => {
  it("leaves nothing behind once forgotten", () => {
    const { system } = world(["blade", "machinegun"]);
    system.addWeapon(ENTITY, "riotgun");
    system.forget(ENTITY);
    expect(system.getWeaponState(ENTITY)).toBeUndefined();
    const inner = system as unknown as Record<string, Map<unknown, unknown> | Set<unknown>>;
    for (const name of ["lastWeaponSlot", "lastSwitchTick", "slotResync"]) expect(inner[name].size, name).toBe(0);
  });
});
