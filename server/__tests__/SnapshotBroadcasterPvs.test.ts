import type { Simulation } from "@engine/server/core/Simulation";
import type { ServerPVS } from "@engine/server/ServerPVS";
import { describe, expect, it } from "vitest";
import { Entity } from "../../../../shared/net/Entity";
import { GameState, PlayerState } from "../../../../shared/net/GameState";
import type { ClientInfo } from "../Client";
import { SnapshotBroadcaster } from "../SnapshotBroadcaster";

function spatialEntity(id: string, x: number): Entity {
  const entity = new Entity(id);
  entity.addComponent("position", {
    x,
    y: 0,
    z: 0,
    serialize() {},
    deserialize() {},
    clone() {
      return this;
    },
  });
  return entity;
}

function player(entityId: string, team: string): PlayerState {
  const value = new PlayerState();
  value.entityId = entityId;
  value.team = team;
  return value;
}

describe("SnapshotBroadcaster PVS filtering", () => {
  it("replicates teammates to a dead player without revealing enemies", () => {
    const viewer = {
      transform: { position: { x: 0, y: 0, z: 0 } },
      health: { dead: true },
    };
    const simulation = {
      getState: () => ({ getEntity: () => viewer }),
    } as unknown as Simulation;
    const broadcaster = new SnapshotBroadcaster(simulation);
    broadcaster.setPVS({
      enabled: true,
      getCluster: () => 0,
      isClusterVisibleFrom: () => false,
    } as unknown as ServerPVS);

    const state = new GameState();
    state.serverTimestamp = 123;
    state.entities.set("player_10", spatialEntity("player_10", 0));
    state.entities.set("player_20", spatialEntity("player_20", 100));
    state.entities.set("player_30", spatialEntity("player_30", 100));
    state.players.set("player_1", player("player_10", "udon"));
    state.players.set("player_2", player("player_20", "udon"));
    state.players.set("player_3", player("player_30", "soba"));

    const client = { playerId: 1, entityId: 10 } as unknown as ClientInfo;
    const filter = broadcaster as unknown as {
      filterStateForClient(value: GameState, info: ClientInfo): GameState;
    };
    const deadView = filter.filterStateForClient(state, client);

    expect([...deadView.entities.keys()]).toEqual(["player_10", "player_20"]);
    expect(deadView.serverTimestamp).toBe(123);

    viewer.health.dead = false;
    const aliveView = filter.filterStateForClient(state, client);
    expect([...aliveView.entities.keys()]).toEqual(["player_10"]);
  });

  it("gives a dead FFA player no teammates: everyone else stays behind the PVS", () => {
    const viewer = { transform: { position: { x: 0, y: 0, z: 0 } }, health: { dead: true } };
    const simulation = { getState: () => ({ getEntity: () => viewer }) } as unknown as Simulation;
    const broadcaster = new SnapshotBroadcaster(simulation);
    broadcaster.setPVS({
      enabled: true,
      getCluster: () => 0,
      isClusterVisibleFrom: () => false,
    } as unknown as ServerPVS);

    const state = new GameState();
    state.entities.set("player_10", spatialEntity("player_10", 0));
    state.entities.set("player_20", spatialEntity("player_20", 100));
    state.entities.set("player_30", spatialEntity("player_30", 100));
    state.players.set("player_1", player("player_10", "ffa"));
    state.players.set("player_2", player("player_20", "ffa"));
    state.players.set("player_3", player("player_30", "ffa"));

    const client = { playerId: 1, entityId: 10 } as unknown as ClientInfo;
    const filter = broadcaster as unknown as {
      filterStateForClient(value: GameState, info: ClientInfo): GameState;
    };
    expect([...filter.filterStateForClient(state, client).entities.keys()]).toEqual(["player_10"]);
  });

  it("sends every dropped weapon, whatever the PVS, and still culls players and projectiles", () => {
    const viewer = { transform: { position: { x: 0, y: 0, z: 0 } }, health: { dead: false } };
    const simulation = { getState: () => ({ getEntity: () => viewer }) } as unknown as Simulation;
    const broadcaster = new SnapshotBroadcaster(simulation);
    broadcaster.setPVS({
      enabled: true,
      getCluster: () => 0,
      isClusterVisibleFrom: () => false,
    } as unknown as ServerPVS);

    const state = new GameState();
    state.entities.set("player_10", spatialEntity("player_10", 0));
    state.entities.set("player_20", spatialEntity("player_20", 900));
    state.entities.set("item_7", spatialEntity("item_7", 900));
    state.entities.set("proj_8", spatialEntity("proj_8", 900));
    state.players.set("player_1", player("player_10", "udon"));
    state.players.set("player_2", player("player_20", "soba"));

    const client = { playerId: 1, entityId: 10 } as unknown as ClientInfo;
    const filter = broadcaster as unknown as {
      filterStateForClient(value: GameState, info: ClientInfo): GameState;
    };
    // A dropped weapon out of view used to be left out, which the client read as
    // picked up: it disposed the weapon and rebuilt it on the way back in.
    expect([...filter.filterStateForClient(state, client).entities.keys()]).toEqual(["player_10", "item_7"]);
  });

  it("looks up each entity's cluster once per snapshot, not once per client", () => {
    const viewer = { transform: { position: { x: 0, y: 0, z: 0 } }, health: { dead: false } };
    const simulation = { getState: () => ({ getEntity: () => viewer }) } as unknown as Simulation;
    const broadcaster = new SnapshotBroadcaster(simulation);
    let lookups = 0;
    broadcaster.setPVS({
      enabled: true,
      getCluster: () => lookups++,
      isClusterVisibleFrom: () => true,
    } as unknown as ServerPVS);

    const state = new GameState();
    for (const id of ["player_10", "player_20", "player_30", "proj_8"]) state.entities.set(id, spatialEntity(id, 0));
    const filter = broadcaster as unknown as {
      filterStateForClient(value: GameState, info: ClientInfo): GameState;
    };
    for (const entityId of [10, 20, 30]) {
      filter.filterStateForClient(state, { playerId: entityId, entityId } as unknown as ClientInfo);
    }
    // Three viewers, plus the four entities once each (no client looks up its own)
    expect(lookups).toBe(3 + 4);
  });
});
