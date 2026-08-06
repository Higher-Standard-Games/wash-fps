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
    broadcaster.setPVS({ enabled: true, isVisible: () => false } as unknown as ServerPVS);

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
});
