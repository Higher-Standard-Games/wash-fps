/**
 * The benchmark scenarios.
 *
 * Each builds its fixture in `prepare()` (not timed) and returns a `run()` that does one unit of
 * work. Fixtures use the real subsystems. What each scenario leaves out is stated in its
 * description, so a fast number is not read as more than it is.
 */

import { EntityType } from "@engine/server/ecs/types";
import type { GameState } from "../../../engine/network/core/GameState";
import { BinaryProtocol } from "../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../engine/network/protocol/MessageCodec";
import { createFullResim } from "../server/ReSim";
import { SnapshotBroadcaster } from "../server/SnapshotBroadcaster";
import { buildSnapshot } from "../server/SnapshotBuilder";
import { PickupSystem } from "../server/systems/PickupSystem";
import { WeaponSystem } from "../server/systems/WeaponSystem";
import { broadcastContext, gridSpawns, pickupEntries, snapshotContext, syntheticLog } from "./fixtures";
import { type BatchOptions, type EachOptions, measureBatch, measureEach, type Stats } from "./harness";

export interface Prepared {
  /** One unit of work: a call, or one simulation tick. */
  run(): void;
  /** Fixture sizes and timing settings. Two results are only comparable if these agree. */
  config: Record<string, number | string | boolean>;
  /** Called after timing, for numbers that are not time: bytes, counts. */
  extras?(): Record<string, number | string>;
  /** Called after timing, for a deterministic workload's final-state fingerprint. */
  checksum?(): number | string;
  /** Time every call separately (a distribution) rather than in batches (an average). */
  each?: EachOptions;
  batch?: BatchOptions;
}

export interface Scenario {
  name: string;
  unit: string;
  description: string;
  prepare(): Prepared;
}

/** Time a prepared scenario and return its statistics. */
export function time(prepared: Prepared): Stats {
  return prepared.each ? measureEach(prepared.run, prepared.each) : measureBatch(prepared.run, prepared.batch);
}

const SNAPSHOT_SIZE = { players: 16, projectiles: 20, droppedWeapons: 10, damageEvents: 8 };

const snapshotConfig = (extra: Record<string, number | string | boolean> = {}) => ({
  ...SNAPSHOT_SIZE,
  iterations: 500,
  repeats: 15,
  ...extra,
});

export const SCENARIOS: Scenario[] = [
  {
    name: "snapshot.build",
    unit: "us per call",
    description:
      "buildSnapshot over 16 players, 20 projectiles, 10 dropped weapons and 8 damage events. The server does this once per snapshot (62.5 times a second). Empty maps of clients, so no per-client work.",
    prepare() {
      const ctx = snapshotContext(SNAPSHOT_SIZE);
      let last = buildSnapshot(ctx);
      return {
        run: () => {
          last = buildSnapshot(ctx);
        },
        config: snapshotConfig(),
        batch: { iterations: 500, repeats: 15 },
        extras: () => ({ entities: last.entities.size, events: last.events.length, players: last.players.size }),
      };
    },
  },
  {
    name: "snapshot.encode",
    unit: "us per call",
    description:
      "BinaryProtocol.encodeSnapshot of the snapshot above, with no baseline (a full snapshot, as demos store).",
    prepare() {
      const state = buildSnapshot(snapshotContext(SNAPSHOT_SIZE));
      let bytes = 0;
      return {
        run: () => {
          bytes = BinaryProtocol.encodeSnapshot(state).length;
        },
        config: snapshotConfig(),
        batch: { iterations: 500, repeats: 15 },
        extras: () => ({ bytesPerSnapshot: bytes }),
      };
    },
  },
  {
    name: "snapshot.buildAndEncode",
    unit: "us per call",
    description:
      "Both together: everything the server does to produce one snapshot's bytes, before per-client culling.",
    prepare() {
      const ctx = snapshotContext(SNAPSHOT_SIZE);
      let bytes = 0;
      return {
        run: () => {
          bytes = BinaryProtocol.encodeSnapshot(buildSnapshot(ctx)).length;
        },
        config: snapshotConfig(),
        batch: { iterations: 500, repeats: 15 },
        extras: () => ({ bytesPerSnapshot: bytes }),
      };
    },
  },
  {
    name: "snapshot.encodeClients16",
    unit: "us per call",
    description:
      "What SnapshotBroadcaster does per snapshot for 16 connected clients: encode the snapshot once for each of them, as a delta against the one they last acknowledged (MessageCodec.encodeSnapshot with a baseline). No PVS culling, so it is the upper end: culling gives each client fewer entities. This is the part of snapshot work that grows with the player count.",
    prepare() {
      const CLIENTS = 16;
      const ctx = snapshotContext(SNAPSHOT_SIZE);
      const baseline = buildSnapshot(ctx);
      // Move every player a little, as a couple of ticks of play would, and build the next snapshot.
      const world = ctx.simulation.getStateMut();
      for (const entity of world.entitiesByType(EntityType.Player)) {
        const mutable = world.getEntityMut(entity.id);
        if (mutable?.transform)
          mutable.transform.position = { ...mutable.transform.position, x: mutable.transform.position.x + 12 };
      }
      const next = buildSnapshot(ctx);
      next.tick = baseline.tick + 2;
      let bytes = 0;
      return {
        run: () => {
          bytes = 0;
          for (let client = 0; client < CLIENTS; client++)
            bytes += MessageCodec.encodeSnapshot(next.shallowCopy(), baseline).length;
        },
        config: snapshotConfig({ clients: CLIENTS, iterations: 100, repeats: 15 }),
        batch: { iterations: 100, repeats: 15 },
        extras: () => ({ bytesAllClients: bytes, bytesPerClient: Math.round(bytes / CLIENTS) }),
      };
    },
  },
  {
    name: "snapshot.broadcast16",
    unit: "us per call",
    description:
      "SnapshotBroadcaster.broadcast for 16 connected clients, each holding the default round loadout, every client acknowledging each snapshot: the per-client copy, delta against the acknowledged one, encode and send, with every 64th a full snapshot as on a live server. Unlike encodeClients16 the snapshot carries what a match sends, a weapon_state per player and the scoreboard standings. No PVS culling.",
    prepare() {
      const CLIENTS = 16;
      const { ctx, sent } = broadcastContext({ ...SNAPSHOT_SIZE, players: CLIENTS });
      const broadcaster = new SnapshotBroadcaster(ctx.simulation);
      const first = buildSnapshot(ctx);
      // Two snapshots a couple of ticks of play apart, sent in turn, so every delta has something in it.
      const world = ctx.simulation.getStateMut();
      for (const entity of world.entitiesByType(EntityType.Player)) {
        const mutable = world.getEntityMut(entity.id);
        if (mutable?.transform)
          mutable.transform.position = { ...mutable.transform.position, x: mutable.transform.position.x + 12 };
      }
      const second = buildSnapshot(ctx);
      const states = [first, second];
      let tick = 100;
      const send = () => {
        const state: GameState = states[tick % 2].shallowCopy();
        state.tick = tick;
        broadcaster.broadcast(ctx.clients, state);
        for (const client of ctx.clients.values()) client.lastAckedTick = tick;
        tick++;
      };
      send(); // the first full snapshot, so the timed ones are deltas
      const events = (state: GameState, type: string) =>
        BinaryProtocol.encodeSnapshot(
          Object.assign(state.shallowCopy(), {
            events: state.events.filter((event) => event.type === type),
            entities: new Map(),
            players: new Map(),
            pickupActiveMask: [],
          }),
        ).length -
        BinaryProtocol.encodeSnapshot(
          Object.assign(state.shallowCopy(), {
            events: [],
            entities: new Map(),
            players: new Map(),
            pickupActiveMask: [],
          }),
        ).length;
      return {
        run: send,
        config: snapshotConfig({ clients: CLIENTS, loadout: "default", iterations: 100, repeats: 15 }),
        batch: { iterations: 100, repeats: 15 },
        extras: () => {
          const sizes = [...sent.values()][0];
          const deltas = sizes.slice(1).sort((a, b) => a - b);
          return {
            bytesPerClient: deltas[Math.floor(deltas.length / 2)],
            fullSnapshotBytes: sizes[0],
            weaponStateBytes: events(second, "weapon_state"),
            matchStateBytes: events(second, "match_state"),
          };
        },
      };
    },
  },
  {
    name: "pickups.update",
    unit: "us per call",
    description:
      "PickupSystem.update with 16 players and 60 pickups, every player far from every pickup, so it measures the scan itself (the respawn check and the player-by-pickup proximity loop) and never a pickup. The server does this every tick (125 times a second).",
    prepare() {
      const ctx = snapshotContext({ players: 16, projectiles: 0, droppedWeapons: 0, damageEvents: 0 });
      const state = ctx.simulation.getStateMut();
      for (const entity of state.entitiesByType(EntityType.Player)) {
        const mutable = state.getEntityMut(entity.id);
        if (mutable?.transform) mutable.transform.position = { x: 50000 + Number(entity.id) * 10, y: 0, z: 50000 };
      }
      const system = new PickupSystem();
      system.setPickupItems(pickupEntries(60));
      let tick = 1000;
      return {
        run: () => {
          system.update(state, 0.008, tick++ as never);
        },
        config: { players: 16, pickups: 60, iterations: 2000, repeats: 15 },
        batch: { iterations: 2000, repeats: 15 },
        // Armor is absent for the first 15 s of a match, so some start inactive. Once that delay has passed (tick 1875) a pickup that is
        // still inactive was taken, and none should be.
        extras: () => ({ inactivePickups: system.getInactivePickups().length }),
      };
    },
  },
  {
    name: "hitscan.resolve16",
    unit: "us per call",
    description:
      "WeaponSystem.update for one machinegun shooter with 15 targets in front of it, one shot per call. No collision world and no lag compensation, so it measures the ray test against every player, not tracing.",
    prepare() {
      const system = new WeaponSystem();
      const loadout = { weapons: ["machinegun"], ammo: { machinegun: 160 }, health: 100, armor: 0 } as never;
      system.initializeWeaponFromLoadout(1 as never, loadout);
      const shooter = {
        id: 1,
        ownerId: 1,
        transform: { position: { x: 0, y: 0, z: 0 } },
        input: { buttons: 1 << 8, yaw: 0, pitch: 0, weaponSlot: 0 },
        health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
      };
      const targets = Array.from({ length: 15 }, (_, i) => ({
        id: i + 2,
        ownerId: i + 2,
        transform: { position: { x: ((i % 5) - 2) * 90, y: 34, z: 300 + Math.floor(i / 5) * 200 } },
        health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
      }));
      const players = [shooter, ...targets];
      const state = {
        entitiesByType: (type: EntityType) => (type === EntityType.Player ? players : []),
        getEntity: (id: number) => players.find((entity) => entity.id === id),
        getEntityMut: (id: number) => players.find((entity) => entity.id === id),
        addEntity: () => {},
        removeEntity: () => {},
      } as never;
      let tick = 100;
      let calls = 0;
      return {
        run: () => {
          // A clip is 30 rounds: top it up now and then so the shooter never sits reloading.
          if (calls++ % 25 === 0) system.initializeWeaponFromLoadout(1 as never, loadout);
          tick += 100; // far apart enough that the fire-rate gate never holds a shot back
          system.update(state, 0.008, tick as never);
          system.getPendingDamage();
        },
        config: { targets: 15, iterations: 1000, repeats: 15 },
        batch: { iterations: 1000, repeats: 15 },
      };
    },
  },
  {
    name: "sim.tick16",
    unit: "us per tick",
    description:
      "One simulation tick of the full movement, weapon, combat and projectile stack with 16 players on seeded random input (the deterministic re-simulation, one tick at a time). No collision world, no gametype and no pickups: it is the simulation without the map, so a real server costs more. The final checksum must not change between runs.",
    prepare() {
      const warmup = 300;
      const ticks = 3000;
      const run = createFullResim(gridSpawns(16), syntheticLog(16, warmup + ticks + 10, 1));
      let t = 0;
      let last = 0;
      return {
        run: () => {
          last = run.step(t++);
        },
        config: { players: 16, seed: 1, ticks, warmup },
        each: { warmup, iterations: ticks },
        checksum: () => last,
      };
    },
  },
];
