/**
 * A bot knows what it sees and hears, not what the server sends: an enemy
 * behind a wall or behind its back is unknown until it makes a sound, and an
 * item taken across the map is still believed there until the bot hears or
 * sees otherwise.
 */

import { describe, expect, it } from "vitest";
import type { IComponent } from "../../../../shared/net/Component";
import { Entity } from "../../../../shared/net/Entity";
import { GameState, PlayerState } from "../../../../shared/net/GameState";
import type { PickupEntry } from "../../shared/bsp/PickupTable";
import { BotGameState, type Vec3 } from "../BotGameState";
import { BotPerception } from "../BotPerception";

const RA: PickupEntry = {
  id: 0,
  classname: "item_armor_body",
  type: "armor",
  kind: "ra",
  position: { x: 0, y: 0, z: 2000 },
};

function player(entityId: string, team = "spectator"): PlayerState {
  const value = new PlayerState();
  value.entityId = entityId;
  value.team = team;
  return value;
}

function entity(id: string, position: Vec3, velocity: Vec3 = { x: 0, y: 0, z: 0 }, grounded = true): Entity {
  const value = new Entity(id);
  value.addComponent("transform", { position, rotation: { x: 0, y: 0, z: 0, w: 1 } } as unknown as IComponent);
  value.addComponent("velocity", { linear: velocity, grounded } as unknown as IComponent);
  return value;
}

interface Scene {
  enemyAt: Vec3;
  enemyVelocity?: Vec3;
  events?: Record<string, unknown>[];
  mask?: boolean[];
  tick?: number;
}

function setup(skill = 1) {
  const state = new BotGameState();
  state.selfEntityId = "self";
  state.selfPlayerId = "bot";
  const perception = new BotPerception({ reactionTimeMs: 0, itemTimingSkill: skill }, () => 0.5);
  const step = (scene: Scene, canSee: (from: Vec3, to: Vec3) => boolean, viewYaw = 0) => {
    const snapshot = new GameState();
    snapshot.tick = scene.tick ?? 100;
    snapshot.players.set("bot", player("self"));
    snapshot.players.set("foe", player("enemy"));
    snapshot.entities.set("self", entity("self", { x: 0, y: 0, z: 0 }));
    snapshot.entities.set("enemy", entity("enemy", scene.enemyAt, scene.enemyVelocity));
    snapshot.events = (scene.events ?? []) as typeof snapshot.events;
    snapshot.pickupActiveMask = scene.mask ?? [true];
    state.update(snapshot as never);
    perception.perceive({ state, snapshot: snapshot as never, viewYaw, canSee, pickups: [RA] });
    return state;
  };
  return { state, step };
}

const clear = () => true;
const walled = () => false;

describe("seeing", () => {
  it("does not know about a silent enemy behind a wall", () => {
    const { step } = setup();
    const state = step({ enemyAt: { x: 0, y: 0, z: 400 } }, walled);
    expect(state.players).toHaveLength(0);
    expect(state.heardEnemies).toHaveLength(0);
    expect(state.lastKnownEnemyPositions.size).toBe(0);
  });

  it("sees an enemy in line of sight and in front", () => {
    const { step } = setup();
    const state = step({ enemyAt: { x: 0, y: 0, z: 400 } }, clear);
    expect(state.players.map((p) => p.playerId)).toEqual(["foe"]);
    expect(state.getNearestEnemy()?.playerId).toBe("foe");
  });

  it("does not see a still enemy behind its back", () => {
    const { step } = setup();
    expect(step({ enemyAt: { x: 0, y: 0, z: -800 } }, clear).players).toHaveLength(0);
  });
});

describe("hearing", () => {
  it("checks a heard enemy behind its view for line of sight before fighting", () => {
    const noise = { enemyAt: { x: 0, y: 0, z: -300 }, enemyVelocity: { x: 0, y: 0, z: 320 } };
    expect(
      setup()
        .step(noise, clear)
        .players.map((p) => p.playerId),
    ).toEqual(["foe"]);
    const hidden = setup().step(noise, walled);
    expect(hidden.players).toHaveLength(0);
    expect(hidden.heardEnemies).toHaveLength(1);
  });

  it("hears someone running close behind it, where they are", () => {
    const { step } = setup();
    const state = step({ enemyAt: { x: 0, y: 0, z: -300 }, enemyVelocity: { x: 0, y: 0, z: 320 } }, walled);
    expect(state.players).toHaveLength(0);
    expect(state.heardEnemies.map((p) => p.position)).toEqual([{ x: 0, y: 0, z: -300 }]);
    expect(state.lastKnownEnemyPositions.get("foe")?.position).toEqual({ x: 0, y: 0, z: -300 });
  });

  it("hears a rocket further than a machinegun", () => {
    const fire = (weaponId: string) => ({
      type: "weapon_fire",
      entityId: "enemy",
      weaponId,
      originX: 0,
      originY: 0,
      originZ: -1600,
    });
    expect(
      setup().step({ enemyAt: { x: 0, y: 0, z: -1600 }, events: [fire("machinegun")] }, walled).heardEnemies,
    ).toHaveLength(0);
    expect(
      setup().step({ enemyAt: { x: 0, y: 0, z: -1600 }, events: [fire("rlauncher")] }, walled).heardEnemies,
    ).toHaveLength(1);
  });
});

describe("item timing by ear", () => {
  it("still believes in an item taken out of earshot and sight", () => {
    const { step } = setup();
    const state = step({ enemyAt: { x: 0, y: 0, z: -3000 }, mask: [false] }, walled);
    expect(state.serverPickupMask).toEqual([false]);
    expect(state.pickupActiveMask).toEqual([true]);
    expect(state.itemTakenTick.size).toBe(0);
  });

  it("times an armour it heard taken, and expects it back after its respawn", () => {
    const { step } = setup(1);
    const pickup = { type: "item_pickup", pickupId: 0, entityId: "enemy", x: 0, y: 0, z: 2000 };
    let state = step({ enemyAt: { x: 0, y: 0, z: 2000 }, events: [pickup], mask: [false], tick: 1000 }, walled);
    expect(state.pickupActiveMask).toEqual([false]);
    expect(state.itemTakenTick.get(0)).toBe(1000);
    expect(state.enemyMajorItems.get("foe")?.kind).toBe("ra");

    // Armour returns 25 s later; with the spot out of sight it is assumed back then.
    state = step({ enemyAt: { x: 0, y: 0, z: 2000 }, mask: [false], tick: 1000 + 25 * 125 }, walled);
    expect(state.pickupActiveMask).toEqual([true]);
  });

  it("notices an item gone when it looks at the empty spot", () => {
    const { step } = setup();
    const state = step({ enemyAt: { x: 0, y: 0, z: -3000 }, mask: [false], tick: 5000 }, clear);
    expect(state.pickupActiveMask).toEqual([false]);
    // Taken some time in the last respawn period: half of it is the guess.
    expect(state.itemTakenTick.get(0)).toBe(5000 - Math.round((25 * 125) / 2));
  });
});
