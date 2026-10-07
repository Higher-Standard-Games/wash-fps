/**
 * Fixtures for the benchmarks: realistic worlds built from the real subsystems, never mocks, so
 * the numbers are the numbers of the code that ships.
 */

import { Simulation } from "@engine/server/core/Simulation";
import { createDroppedWeaponEntity, createPlayerEntity, createProjectileEntity } from "@engine/server/ecs/Entity";
import { entityId, playerId } from "@engine/server/ecs/types";
import type { PickupEntry } from "../../../shared/bsp/PickupTable";
import { buildLoadout, DEFAULT_LOADOUT } from "../../../shared/server/gametype";
import type { ClientInfo } from "../server/Client";
import { Duel } from "../server/gametypes/Duel";
import { GametypeController } from "../server/gametypes/GametypeController";
import type { RecordedCmd, ReSimSpawn } from "../server/ReSim";
import type { SnapshotContext } from "../server/SnapshotBuilder";
import { CombatSystem, DamageType, HitLocation, type ProcessedDamage } from "../server/systems/CombatSystem";
import { DroppedWeaponSystem } from "../server/systems/DroppedWeaponSystem";
import { PickupSystem } from "../server/systems/PickupSystem";
import { ProjectileSystem } from "../server/systems/ProjectileSystem";
import { WeaponSystem } from "../server/systems/WeaponSystem";

/** A small, fast, seedable generator (mulberry32), so a fixture is the same every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SnapshotFixtureSize {
  players: number;
  projectiles: number;
  droppedWeapons: number;
  damageEvents: number;
}

/** A world with the given numbers of players, projectiles and dropped weapons, and pending damage events. */
export function snapshotContext(size: SnapshotFixtureSize): SnapshotContext {
  const random = seededRandom(7);
  const simulation = new Simulation({ tickMs: 8 });
  simulation.initialize();
  const state = simulation.getStateMut();
  const botNames = new Map();

  for (let i = 1; i <= size.players; i++) {
    const position = { x: (random() - 0.5) * 2000, y: 100 + random() * 200, z: (random() - 0.5) * 2000 };
    state.addEntity(createPlayerEntity(entityId(i), playerId(i), position));
    botNames.set(playerId(i), `Player ${i}`);
  }
  for (let j = 0; j < size.projectiles; j++) {
    const position = { x: (random() - 0.5) * 2000, y: 100 + random() * 200, z: (random() - 0.5) * 2000 };
    const owner = playerId(1 + (j % Math.max(1, size.players)));
    state.addEntity(createProjectileEntity(entityId(1000 + j), owner, position, { x: 900, y: 0, z: 0 }));
  }
  for (let k = 0; k < size.droppedWeapons; k++) {
    const position = { x: (random() - 0.5) * 2000, y: 20, z: (random() - 0.5) * 2000 };
    state.addEntity(createDroppedWeaponEntity(entityId(2000 + k), position, { x: 0, y: 0, z: 0 }, "rlauncher"));
  }

  const combatSystem = new CombatSystem();
  const damage: ProcessedDamage[] = [];
  for (let d = 0; d < size.damageEvents; d++) {
    damage.push({
      victimId: entityId(1 + (d % Math.max(1, size.players))),
      attackerId: entityId(1 + ((d + 1) % Math.max(1, size.players))),
      damage: 10 + d,
      damageType: DamageType.Bullet,
      hitLocation: d % 4 === 0 ? HitLocation.Head : HitLocation.Body,
      x: 0,
      y: 0,
      z: 0,
    });
  }
  (combatSystem as unknown as { processedDamage: ProcessedDamage[] }).processedDamage = damage;

  return {
    simulation,
    weaponSystem: new WeaponSystem(),
    projectileSystem: new ProjectileSystem(),
    combatSystem,
    pickupSystem: new PickupSystem(),
    droppedWeaponSystem: new DroppedWeaponSystem(),
    gametypeController: new GametypeController(new Duel()),
    clients: new Map(),
    botNames,
    knownProjectileIds: new Set(),
    pendingKillEvents: [],
    pendingChatEvents: [],
    pendingAwards: [],
    needsPickupSync: new Set(),
  };
}

/** A map's worth of pickups, spread out, a third of them weapons. */
export function pickupEntries(count: number): PickupEntry[] {
  const random = seededRandom(11);
  const kinds: Array<Pick<PickupEntry, "classname" | "type" | "kind">> = [
    { classname: "weapon_rocketlauncher", type: "weapon", kind: "rlauncher" },
    { classname: "ammo_rockets", type: "ammo", kind: "rockets" },
    { classname: "item_health_large", type: "health", kind: "large" },
    { classname: "item_armor_ya", type: "armor", kind: "ya" },
  ];
  return Array.from({ length: count }, (_, id) => ({
    id,
    ...kinds[id % kinds.length],
    position: { x: (random() - 0.5) * 6000, y: 24, z: (random() - 0.5) * 6000 },
  })) as PickupEntry[];
}

/**
 * A seeded input log for `players` players over `ticks` ticks: mostly running forward, strafing
 * left and right, turning, and firing about a third of the time. Player i is entity i.
 */
export function syntheticLog(players: number, ticks: number, seed: number): RecordedCmd[] {
  const random = seededRandom(seed);
  const FIRE = 1 << 8;
  const log: RecordedCmd[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    for (let p = 1; p <= players; p++) {
      log.push({
        tick,
        entityId: p,
        cmd: {
          forward: random() < 0.85 ? 1 : 0,
          right: random() < 0.5 ? 1 : -1,
          pitch: 0,
          yaw: (tick * 0.02 + p) % (Math.PI * 2),
          buttons: random() < 0.33 ? FIRE : 0,
          sequence: tick + 1,
          weaponSlot: 0,
        },
      });
    }
  }
  return log;
}

/** Players on a grid, close enough that some shots find a target. */
export function gridSpawns(players: number): ReSimSpawn[] {
  const side = Math.ceil(Math.sqrt(players));
  return Array.from({ length: players }, (_, i) => ({
    entityId: i + 1,
    playerId: i + 1,
    x: (i % side) * 64,
    y: 500,
    z: Math.floor(i / side) * 64,
  }));
}

/**
 * The snapshot world above as a live match sees it: every player connected as a client (so the
 * scoreboard standings are filled in) and holding the default round loadout (so each sends a
 * weapon_state). Each client's connection records the size of every datagram sent to it.
 */
export function broadcastContext(size: SnapshotFixtureSize): { ctx: SnapshotContext; sent: Map<string, number[]> } {
  const ctx = snapshotContext(size);
  const sent = new Map<string, number[]>();
  const clients = ctx.clients as Map<string, ClientInfo>;
  for (let i = 1; i <= size.players; i++) {
    ctx.weaponSystem.initializeWeaponFromLoadout(entityId(i), buildLoadout(DEFAULT_LOADOUT));
    const id = `client_${i}`;
    const sizes: number[] = [];
    sent.set(id, sizes);
    clients.set(id, {
      id,
      playerId: playerId(i),
      entityId: entityId(i),
      playerName: `Player ${i}`,
      resumeToken: "",
      lastInputSeq: 0,
      lastAckedTick: -1,
      ping: 40,
      isSpectator: false,
      connection: { latency: 40, sendDatagram: (bytes: Uint8Array) => sizes.push(bytes.length) },
    } as unknown as ClientInfo);
  }
  return { ctx, sent };
}
