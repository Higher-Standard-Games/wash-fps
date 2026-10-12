import { Simulation } from "@engine/server/core/Simulation";
import { createDroppedWeaponEntity, createPlayerEntity, createProjectileEntity } from "@engine/server/ecs/Entity";
import { entityId, playerId } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import type { GameState } from "../../../../engine/network/core/GameState";
import { BinaryProtocol } from "../../../../shared/net/BinaryProtocol";
import type { ClientInfo } from "../Client";
import { Duel } from "../gametypes/Duel";
import { GametypeController } from "../gametypes/GametypeController";
import { buildSnapshot, type SnapshotContext } from "../SnapshotBuilder";
import { CombatSystem, DamageType, HitLocation, type ProcessedDamage } from "../systems/CombatSystem";
import { DroppedWeaponSystem } from "../systems/DroppedWeaponSystem";
import { PickupSystem } from "../systems/PickupSystem";
import { ProjectileSystem } from "../systems/ProjectileSystem";
import { WeaponSystem } from "../systems/WeaponSystem";

/**
 * Golden test for buildSnapshot: a small, fixed world and the exact GameState it
 * produces. This is the wire and demo input, so any change in entity keys,
 * components, f32 quantization or event shape shows up here as a diff.
 *
 * If a change is intended, update the expected values with `npx vitest run -u` on this
 * file and read the diff before committing it.
 */

/** A GameState as plain data: function members dropped, maps as sorted entries. */
function plain(state: GameState) {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) if (typeof v !== "function") out[k] = strip(v);
      return out;
    }
    return value;
  };
  const sorted = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    tick: state.tick,
    entities: sorted(state.entities).map(([id, entity]) => [
      id,
      Object.fromEntries(entity.getComponentNames().map((name) => [name, strip(entity.getComponent(name))])),
    ]),
    players: sorted(state.players).map(([id, p]) => [id, strip(p)]),
    events: strip(state.events),
    pickupActiveMask: state.pickupActiveMask,
  };
}

function world() {
  const simulation = new Simulation({ tickMs: 8 });
  simulation.initialize();
  const state = simulation.getStateMut();

  // A connected player, alive, at positions that are not exact in float32.
  const ada = createPlayerEntity(entityId(1), playerId(1), { x: 0.1, y: 24.3, z: -7.7 });
  ada.physics!.velocity = { x: 1.1, y: 0, z: 2.2 };
  ada.physics!.grounded = true;
  state.addEntity(ada);

  // A bot that is dead: no entity is sent, but its scoreboard and combat state are.
  const bob = createPlayerEntity(entityId(2), playerId(2), { x: 100, y: 0, z: 100 });
  bob.health!.health = -12;
  bob.health!.dead = true;
  state.addEntity(bob);

  const rocket = createProjectileEntity(entityId(10), playerId(1), { x: 5.5, y: 30, z: 0 }, { x: 0, y: 0, z: 900 });
  state.addEntity(rocket);
  state.addEntity(createDroppedWeaponEntity(entityId(50001), { x: -3, y: 16, z: 8 }, undefined, "riotgun"));

  const weaponSystem = new WeaponSystem();
  weaponSystem.initializeWeapon(entityId(1));
  weaponSystem.initializeWeapon(entityId(2));

  const projectileSystem = new ProjectileSystem();
  projectileSystem.registerProjectileType(entityId(10), "rocket");

  const droppedWeaponSystem = new DroppedWeaponSystem();
  (droppedWeaponSystem as unknown as { droppedWeapons: Map<number, unknown> }).droppedWeapons.set(50001, {
    entityId: entityId(50001),
    weaponId: "riotgun",
    ammo: 10,
    spawnTick: 0,
    velocity: { x: 0, y: 0, z: 0 },
    settled: true,
    floorY: 16,
  });

  const combatSystem = new CombatSystem();
  const damage: ProcessedDamage[] = [
    {
      victimId: entityId(2),
      attackerId: entityId(1),
      damage: 55,
      damageType: DamageType.Bullet,
      hitLocation: HitLocation.Head,
      x: 100,
      y: 40,
      z: 100,
    },
  ];
  (combatSystem as unknown as { processedDamage: ProcessedDamage[] }).processedDamage = damage;

  const clients = new Map<string, ClientInfo>([
    ["c1", { id: "c1", playerId: playerId(1), entityId: entityId(1), playerName: "Ada", ping: 23.6 } as ClientInfo],
    [
      "c3",
      {
        id: "c3",
        playerId: playerId(3),
        entityId: entityId(3),
        playerName: "Spec",
        ping: 0,
        isSpectator: true,
      } as ClientInfo,
    ],
  ]);

  // Ada picks up a machinegun: the picker's id is numeric on the server.
  const pickupSystem = new PickupSystem();
  (pickupSystem as unknown as { pendingPickupEvents: unknown[] }).pendingPickupEvents = [
    { pickupId: 4, weaponId: "machinegun", entityId: entityId(1), x: 1, y: 2, z: 3 },
  ];
  (droppedWeaponSystem as unknown as { pendingDropEvents: unknown[] }).pendingDropEvents = [
    { entityId: "item_50001", weaponId: "riotgun", x: -3, y: 40, z: 8, velX: 10, velY: 50, velZ: 0 },
  ];

  const ctx: SnapshotContext = {
    simulation,
    weaponSystem,
    projectileSystem,
    combatSystem,
    pickupSystem,
    droppedWeaponSystem,
    gametypeController: new GametypeController(new Duel()),
    clients,
    botNames: new Map([[playerId(2), "Bob"]]),
    knownProjectileIds: new Set(),
    pendingKillEvents: [
      {
        victimId: entityId(2),
        killerId: entityId(1),
        damageType: DamageType.Bullet,
        finalDamage: 55,
        tick: 0 as never,
        victimX: 100,
        victimY: 0,
        victimZ: 100,
        victimVelX: 0,
        victimVelY: 0,
        victimVelZ: 0,
        kbDirX: 1,
        kbDirY: 0,
        kbDirZ: 0,
      },
    ],
    pendingChatEvents: [{ senderId: "player_1", senderName: "Ada", team: "", text: "gg" }],
    pendingAwards: [{ awardType: "excellent", playerId: playerId(1), playerName: "Ada", targetName: "Bob", value: 2 }],
    needsPickupSync: new Set(),
  };
  return ctx;
}

describe("buildSnapshot golden", () => {
  it("produces the expected GameState for a fixed world", () => {
    expect(plain(buildSnapshot(world()))).toMatchInlineSnapshot(`
      {
        "entities": [
          [
            "item_50001",
            {
              "position": {
                "x": -3,
                "y": 16,
                "z": 8,
              },
              "transform": {
                "position": {
                  "x": -3,
                  "y": 16,
                  "z": 8,
                },
                "rotation": {
                  "w": 1,
                  "x": 0,
                  "y": 0,
                  "z": 0,
                },
              },
              "weaponMeta": {
                "settled": true,
                "weaponId": "riotgun",
              },
            },
          ],
          [
            "player_1",
            {
              "movementState": {
                "actualHorizSpeed": 0,
                "crouchViewOffset": 0,
                "isCrouching": false,
                "isSliding": false,
                "ledgeGrabState": "none",
                "wallJumpState": "none",
              },
              "position": {
                "x": 0.10000000149011612,
                "y": 24.299999237060547,
                "z": -7.699999809265137,
              },
              "powerups": {
                "mask": 0,
              },
              "transform": {
                "position": {
                  "x": 0.10000000149011612,
                  "y": 24.299999237060547,
                  "z": -7.699999809265137,
                },
                "rotation": {
                  "w": 1,
                  "x": 0,
                  "y": 0,
                  "z": 0,
                },
              },
              "velocity": {
                "angular": {
                  "x": 0,
                  "y": 0,
                  "z": 0,
                },
                "grounded": true,
                "linear": {
                  "x": 1.100000023841858,
                  "y": 0,
                  "z": 2.200000047683716,
                },
                "x": 1.100000023841858,
                "y": 0,
                "z": 2.200000047683716,
              },
            },
          ],
          [
            "proj_10",
            {
              "position": {
                "x": 5.5,
                "y": 30,
                "z": 0,
              },
              "transform": {
                "position": {
                  "x": 5.5,
                  "y": 30,
                  "z": 0,
                },
                "rotation": {
                  "w": 1,
                  "x": 0,
                  "y": 0,
                  "z": 0,
                },
              },
              "velocity": {
                "angular": {
                  "x": 0,
                  "y": 0,
                  "z": 0,
                },
                "grounded": false,
                "linear": {
                  "x": 0,
                  "y": 0,
                  "z": 900,
                },
                "x": 0,
                "y": 0,
                "z": 900,
              },
            },
          ],
        ],
        "events": [
          {
            "ageTicks": null,
            "entityId": "player_1",
            "type": "knockback_state",
          },
          {
            "armor": 0,
            "dead": false,
            "entityId": "player_1",
            "health": 100,
            "type": "combat_state",
          },
          {
            "ammo": {
              "blade": {
                "clip": 1,
                "reserve": 0,
              },
              "electrobolt": {
                "clip": 10,
                "reserve": 0,
              },
              "glauncher": {
                "clip": 20,
                "reserve": 0,
              },
              "instagun": {
                "clip": 5,
                "reserve": 0,
              },
              "machinegun": {
                "clip": 30,
                "reserve": 120,
              },
              "plasmagun": {
                "clip": 50,
                "reserve": 150,
              },
              "riotgun": {
                "clip": 8,
                "reserve": 24,
              },
              "rlauncher": {
                "clip": 20,
                "reserve": 0,
              },
              "voltaic": {
                "clip": 120,
                "reserve": 60,
              },
            },
            "currentWeapon": "blade",
            "entityId": "player_1",
            "lastFireTick": 0,
            "reloading": false,
            "type": "weapon_state",
            "weapons": [
              "blade",
            ],
          },
          {
            "ageTicks": null,
            "entityId": "player_2",
            "type": "knockback_state",
          },
          {
            "armor": 0,
            "dead": true,
            "entityId": "player_2",
            "health": 0,
            "type": "combat_state",
          },
          {
            "ammo": {
              "blade": {
                "clip": 1,
                "reserve": 0,
              },
              "electrobolt": {
                "clip": 10,
                "reserve": 0,
              },
              "glauncher": {
                "clip": 20,
                "reserve": 0,
              },
              "instagun": {
                "clip": 5,
                "reserve": 0,
              },
              "machinegun": {
                "clip": 30,
                "reserve": 120,
              },
              "plasmagun": {
                "clip": 50,
                "reserve": 150,
              },
              "riotgun": {
                "clip": 8,
                "reserve": 24,
              },
              "rlauncher": {
                "clip": 20,
                "reserve": 0,
              },
              "voltaic": {
                "clip": 120,
                "reserve": 60,
              },
            },
            "currentWeapon": "blade",
            "entityId": "player_2",
            "lastFireTick": 0,
            "reloading": false,
            "type": "weapon_state",
            "weapons": [
              "blade",
            ],
          },
          {
            "defId": "rocket",
            "entityId": "proj_10",
            "type": "projectile_spawn",
          },
          {
            "flow": "continuous",
            "gametypeName": "Duel",
            "overtime": undefined,
            "phase": 0,
            "playerTeams": {},
            "readyCount": 0,
            "round": undefined,
            "scoreLimit": 0,
            "spectators": [
              {
                "name": "Spec",
                "ping": 0,
                "playerId": "player_3",
              },
            ],
            "standings": [
              {
                "deaths": 0,
                "frags": 0,
                "name": "Ada",
                "ping": 0,
                "playerId": "player_1",
                "score": 0,
              },
              {
                "deaths": 0,
                "frags": 0,
                "name": "Spec",
                "ping": 0,
                "playerId": "player_3",
                "score": 0,
              },
            ],
            "teamBased": true,
            "teamNames": {
              "soba": "Team Soba",
              "spectator": "Spectator",
              "udon": "Team Udon",
            },
            "teamRoles": undefined,
            "teamScores": {
              "soba": 0,
              "spectator": 0,
              "udon": 0,
            },
            "timeRemaining": 120,
            "totalPlayers": 0,
            "type": "match_state",
            "winner": undefined,
          },
          {
            "droppedWeaponId": "",
            "entityId": "1",
            "pickupId": 4,
            "type": "item_pickup",
            "weaponId": "machinegun",
            "x": 1,
            "y": 2,
            "z": 3,
          },
          {
            "entityId": "item_50001",
            "type": "weapon_drop",
            "velX": 10,
            "velY": 50,
            "velZ": 0,
            "weaponId": "riotgun",
            "x": -3,
            "y": 40,
            "z": 8,
          },
          {
            "attackerId": "player_1",
            "damage": 55,
            "entityId": "player_2",
            "hitLocation": "head",
            "type": "damage",
            "weaponId": "bullet",
            "x": 100,
            "y": 40,
            "z": 100,
          },
          {
            "damageType": "bullet",
            "entityId": "player_2",
            "finalDamage": 55,
            "kbDirX": 1,
            "kbDirY": 0,
            "kbDirZ": 0,
            "killerId": "player_1",
            "type": "death",
            "velX": 0,
            "velY": 0,
            "velZ": 0,
            "weaponId": "bullet",
            "x": 100,
            "y": 0,
            "z": 100,
          },
          {
            "senderId": "player_1",
            "senderName": "Ada",
            "team": "",
            "text": "gg",
            "type": "chat",
          },
          {
            "awardType": "excellent",
            "playerId": "player_1",
            "playerName": "Ada",
            "targetName": "Bob",
            "type": "award",
            "value": 2,
          },
        ],
        "pickupActiveMask": [],
        "players": [
          [
            "player_1",
            {
              "deaths": 0,
              "entityId": "player_1",
              "name": "Ada",
              "ping": 24,
              "score": 0,
              "team": "spectator",
            },
          ],
          [
            "player_2",
            {
              "deaths": 0,
              "entityId": "player_2",
              "name": "Bob",
              "ping": 0,
              "score": 0,
              "team": "spectator",
            },
          ],
        ],
        "tick": 0,
      }
    `);
  });

  it("survives the wire: every event encodes and decodes with its fields", () => {
    const built = buildSnapshot(world());
    const decoded = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(built));
    expect(decoded.events.map((e) => e.type)).toEqual(built.events.map((e) => e.type));
    const pickup = decoded.events.find((e) => e.type === "item_pickup");
    expect(pickup).toMatchObject({ pickupId: 4, weaponId: "machinegun", entityId: "1" });
    expect(decoded.events.find((e) => e.type === "weapon_drop")).toMatchObject({ entityId: "item_50001", velY: 50 });
    expect([...decoded.entities.keys()].sort()).toEqual([...built.entities.keys()].sort());
  });

  it("sends one-shot events once: a second build has no spawn, damage, kill, chat or award", () => {
    const ctx = world();
    buildSnapshot(ctx);
    const types = buildSnapshot(ctx).events.map((e) => e.type);
    for (const once of ["projectile_spawn", "damage", "death", "chat", "award"]) {
      expect(types).not.toContain(once);
    }
    expect(types).toContain("match_state");
    expect(types).toContain("weapon_state");
  });
});
