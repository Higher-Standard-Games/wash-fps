import type { Simulation } from "@engine/server/core/Simulation";
import type { ServerPVS } from "@engine/server/ServerPVS";
import { describe, expect, it } from "vitest";
import { GameState } from "../../../../shared/net/GameState";
import type { ClientInfo } from "../Client";
import { HEARING_RADIUS, SnapshotBroadcaster } from "../SnapshotBroadcaster";

type Events = GameState["events"];

function setup(visible: (from: number, to: number) => boolean) {
  const viewer = { transform: { position: { x: 0, y: 0, z: 0 } }, health: { dead: false } };
  const simulation = { getState: () => ({ getEntity: () => viewer }) } as unknown as Simulation;
  const broadcaster = new SnapshotBroadcaster(simulation);
  // One cluster per 1000 units along x
  broadcaster.setPVS({
    enabled: true,
    getCluster: (at: { x: number }) => Math.floor(at.x / 1000),
    isClusterVisibleFrom: visible,
  } as unknown as ServerPVS);
  const client = { playerId: 1, entityId: 10, lastAckedTick: 0 } as unknown as ClientInfo;
  const internals = broadcaster as unknown as {
    viewpointsOf(state: GameState, info: ClientInfo): unknown;
    perceives(view: unknown, x: number, y: number, z: number): boolean;
    leaveOutKnown(
      info: ClientInfo,
      events: Events,
      lasting: Map<string, string>,
      tick: number,
      seesHealthOf: (id: string) => boolean,
      perceives?: (x: number, y: number, z: number) => boolean,
    ): Events;
  };
  const view = internals.viewpointsOf(new GameState(), client);
  const filter = (events: Events) =>
    internals.leaveOutKnown(
      client,
      events,
      new Map(),
      1,
      () => true,
      (x, y, z) => internals.perceives(view, x, y, z),
    );
  return { filter };
}

function fire(entityId: string, x: number): Events[number] {
  return {
    type: "weapon_fire",
    entityId,
    weaponId: "machinegun",
    originX: x,
    originY: 0,
    originZ: 0,
    dirX: 1,
    dirY: 0,
    dirZ: 0,
  } as Events[number];
}

describe("positional events and what a client can perceive", () => {
  const far = HEARING_RADIUS + 5000;

  it("drops gunfire out of view and out of earshot", () => {
    const { filter } = setup(() => false);
    expect(filter([fire("player_20", far)])).toEqual([]);
  });

  it("keeps gunfire in earshot through a wall", () => {
    const { filter } = setup(() => false);
    expect(filter([fire("player_20", HEARING_RADIUS - 10)])).toHaveLength(1);
  });

  it("keeps far gunfire the client can see", () => {
    const { filter } = setup(() => true);
    expect(filter([fire("player_20", far)])).toHaveLength(1);
  });

  it("keeps the client's own shots, hits on it and hits it lands", () => {
    const { filter } = setup(() => false);
    const hit = (entityId: string, attackerId: string) =>
      ({
        type: "damage",
        entityId,
        attackerId,
        damage: 10,
        weaponId: "machinegun",
        x: far,
        y: 0,
        z: 0,
      }) as Events[number];
    expect(filter([fire("player_10", far), hit("player_10", "player_20"), hit("player_20", "player_10")])).toHaveLength(
      3,
    );
    expect(filter([hit("player_20", "player_30")])).toEqual([]);
  });

  it("drops a far pickup by someone else and keeps the client's own", () => {
    const { filter } = setup(() => false);
    const pickup = (entityId: string) =>
      ({
        type: "item_pickup",
        pickupId: 1,
        weaponId: "",
        entityId,
        droppedWeaponId: "",
        x: far,
        y: 0,
        z: 0,
      }) as Events[number];
    expect(filter([pickup("20")])).toEqual([]);
    expect(filter([pickup("10")])).toHaveLength(1);
  });

  it("leaves the kill feed alone", () => {
    const { filter } = setup(() => false);
    const death = { type: "death", entityId: "player_20", killerId: "player_30", x: far, y: 0, z: 0 } as Events[number];
    expect(filter([death])).toHaveLength(1);
  });
});
