import { createPlayerEntity } from "@engine/server/ecs/Entity";
import { EntityType, playerId } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it, vi } from "vitest";

vi.mock("@engine/server/network/transport/WebSocketTransport", () => import("./_fakeTransport"));

import type { PickupEntry } from "../../../../shared/bsp/PickupTable";
import { GameServer, type GameServerConfig } from "../GameServer";
import { DamageType, HitLocation } from "../systems/CombatSystem";

const config: GameServerConfig = {
  port: 0,
  serverName: "match-reset-test",
  mapName: "wdm2",
  maxClients: 2,
  tickRate: 125,
  snapshotRate: 60,
  certPath: "",
  keyPath: "",
};

describe("GameServer match-start world reset", () => {
  it("clears warmup world state before respawning players", () => {
    const server = new GameServer(config);
    // biome-ignore lint/suspicious/noExplicitAny: focused lifecycle integration test
    const internals = server as any;
    const state = internals.simulation.getStateMut();
    const pid = playerId(1);
    const eid = state.generateEntityId();

    internals.gametypeController.setSpawnPoints([{ x: 100, y: 48, z: 200 }]);
    internals.gametypeController.onPlayerJoin(pid, eid, state, undefined, "Tester");

    const player = createPlayerEntity(eid, pid, { x: 0, y: 0, z: 0 });
    player.health!.health = 0;
    player.health!.armor = 77;
    player.health!.dead = true;
    player.input!.buttons = 0xffff;
    player.input!.inputQueue.push({
      forward: 1,
      right: 1,
      pitch: 0,
      yaw: 0,
      buttons: 0xffff,
      sequence: 9,
      weaponSlot: 3,
    });
    state.addEntity(player);

    const opponentId = playerId(2);
    const opponentEntityId = state.generateEntityId();
    internals.gametypeController.onPlayerJoin(opponentId, opponentEntityId, state, undefined, "Opponent");
    state.addEntity(createPlayerEntity(opponentEntityId, opponentId, { x: 0, y: 0, z: 0 }));

    const pickups: PickupEntry[] = [
      {
        id: 0,
        classname: "item_health_small",
        type: "health",
        kind: "small",
        position: { x: 9999, y: 0, z: 0 },
      },
      {
        id: 1,
        classname: "item_armor_ra",
        type: "armor",
        kind: "ra",
        position: { x: 9999, y: 0, z: 0 },
      },
    ];
    internals.pickupSystem.setPickupItems(pickups);
    internals.pickupSystem.pickups[0].active = false;

    internals.droppedWeaponSystem.queueDrop({
      weaponId: "rlauncher",
      ammo: 10,
      position: { x: 0, y: 64, z: 0 },
    });
    internals.droppedWeaponSystem.update(state, 1 / 125, 1000);
    expect([...state.entitiesByType(EntityType.Item)]).toHaveLength(1);

    // This damage would kill the fresh spawn on the following tick if the
    // warmup queue crossed the phase boundary.
    internals.combatSystem.queueDamage({
      victimId: eid,
      damage: 999,
      armorPiercing: 1,
      damageType: DamageType.World,
      hitLocation: HitLocation.Body,
    });

    const matchState = internals.gametypeController.getMatchState();
    matchState.transition(MatchPhase.Countdown);
    matchState._timeRemaining = 0;
    internals.gametypeController.postTick(state, 1 / 125, 1001);

    expect(matchState.phase).toBe(MatchPhase.Active);
    expect([...state.entitiesByType(EntityType.Item)]).toHaveLength(0);
    expect(internals.pickupSystem.getActiveMask()).toEqual([true, false]);

    const respawned = state.getEntity(eid)!;
    expect(respawned.health).toMatchObject({ health: 100, armor: 0, dead: false });
    expect(respawned.input!.buttons).toBe(0);
    expect(respawned.input!.inputQueue).toHaveLength(0);

    internals.combatSystem.update(state, 1 / 125, 1002);
    expect(state.getEntity(eid)!.health).toMatchObject({ health: 100, armor: 0, dead: false });
  });
});
