/**
 * SnapshotBuilder — Converts server simulation state to a GameState for network transmission.
 *
 * Pure(-ish) data transformation extracted from GameServer. Takes simulation state
 * and subsystem references via a SnapshotContext, returns a wire-ready GameState.
 *
 * Side effects: tracks known projectile IDs, clears pending events from subsystems.
 */

import type { Simulation } from "@engine/server/core/Simulation";
import type { PlayerId } from "@engine/server/ecs/types";
import { EntityType } from "@engine/server/ecs/types";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "@shared/server/simulation/physics/constants";
import { Entity } from "../../../engine/network/core/Entity";
import { GameState, type PlayerState } from "../../../engine/network/core/GameState";
import { POWERUP_KINDS, packPowerupMask, powerupSecondsRemaining } from "../../../shared/items/Powerups";
import { toClientKey } from "../ClientEntityKey";
import type { ClientInfo } from "./Client";
import type { AwardEvent } from "./gametypes/AwardTracker";
import type { GametypeController } from "./gametypes/GametypeController";
import type { CombatSystem, KillEvent } from "./systems/CombatSystem";
import type { DroppedWeaponSystem } from "./systems/DroppedWeaponSystem";
import type { PickupSystem } from "./systems/PickupSystem";
import type { ProjectileSystem } from "./systems/ProjectileSystem";
import type { WeaponSystem } from "./systems/WeaponSystem";

// ── Hoisted closures (same pattern as BinaryProtocol decode side) ──
// These are no-op stubs shared by all components to avoid per-entity allocations.
const _noopSerialize = () => ({});
const _noopDeserialize = () => {
  /* no-op */
};
function _shallowClone(this: any) {
  return { ...this };
}
function _transformClone(this: any) {
  return {
    position: { ...this.position },
    rotation: { ...this.rotation },
    serialize: _noopSerialize,
    deserialize: _noopDeserialize,
    clone: _transformClone,
  };
}
function _velocityClone(this: any) {
  return {
    x: this.x,
    y: this.y,
    z: this.z,
    linear: { ...this.linear },
    angular: { ...this.angular },
    grounded: this.grounded,
    serialize: _noopSerialize,
    deserialize: _noopDeserialize,
    clone: _velocityClone,
  };
}

/**
 * Context required by the snapshot builder — references to all subsystems
 * and mutable state that toGameState needs.
 */
export interface SnapshotContext {
  simulation: Simulation;
  weaponSystem: WeaponSystem;
  projectileSystem: ProjectileSystem;
  combatSystem: CombatSystem;
  pickupSystem: PickupSystem;
  droppedWeaponSystem: DroppedWeaponSystem;
  gametypeController: GametypeController;

  /** Connected clients — needed for player name/ping lookups */
  clients: Map<string, ClientInfo>;
  /** Bot player ID → display name */
  botNames: Map<PlayerId, string>;

  /** Mutable: track projectile entity IDs we've already sent spawn events for */
  knownProjectileIds: Set<number>;
  /** Mutable: kill events cached since last snapshot */
  pendingKillEvents: KillEvent[];
  /** Chat messages queued by GameServer.handleChat (sanitized + rate-limited). */
  pendingChatEvents: Array<{ senderId: string; senderName: string; team: string; text: string }>;
  /** Mutable: award events cached since last snapshot */
  pendingAwards: AwardEvent[];
  /** Mutable: clients that need initial pickup state sync */
  needsPickupSync: Set<string>;
}

/**
 * Quantize a float64 to float32 precision.
 * BinaryProtocol encodes positions/velocities as float32 on the wire.
 * Without pre-quantization, the server's snapshot history stores float64
 * values while the client decodes float32 — causing a tiny but systematic
 * error every reconciliation cycle that accumulates into visualOffset,
 * progressively drifting the camera away from the collision world.
 */
function f32(v: number): number {
  return Math.fround(v);
}

/**
 * Build a wire-ready GameState from the current simulation state.
 *
 * This is a direct extraction of GameServer.toGameState() with hoisted closures
 * and an explicit context parameter instead of `this`.
 */
export function buildSnapshot(ctx: SnapshotContext): GameState {
  const state = ctx.simulation.getState();
  const gameState = new GameState();
  gameState.tick = Number(state.tick);
  const tickNum = gameState.tick;

  // Build O(1) player-to-client lookup map (avoids O(clients) scan per entity)
  const clientByPlayerId = new Map<PlayerId, ClientInfo>();
  for (const client of ctx.clients.values()) {
    if (client.playerId !== undefined) {
      clientByPlayerId.set(client.playerId, client);
    }
  }

  // Convert entities (including projectiles — Q3-style server-rendered)
  for (const entity of state.allEntities()) {
    // Projectile entities get a separate path (proj_ prefix, no player state)
    if (entity.type === EntityType.Projectile) {
      const projEntity = new Entity(`proj_${entity.id}`);
      if (entity.transform) {
        projEntity.addComponent("transform", {
          position: {
            x: f32(entity.transform.position.x),
            y: f32(entity.transform.position.y),
            z: f32(entity.transform.position.z),
          },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _transformClone,
        });
        projEntity.addComponent("position", {
          x: f32(entity.transform.position.x),
          y: f32(entity.transform.position.y),
          z: f32(entity.transform.position.z),
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _shallowClone,
        });
      }
      if (entity.physics) {
        projEntity.addComponent("velocity", {
          x: f32(entity.physics.velocity.x),
          y: f32(entity.physics.velocity.y),
          z: f32(entity.physics.velocity.z),
          linear: {
            x: f32(entity.physics.velocity.x),
            y: f32(entity.physics.velocity.y),
            z: f32(entity.physics.velocity.z),
          },
          angular: { x: 0, y: 0, z: 0 },
          grounded: false,
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _velocityClone,
        });
      }
      gameState.entities.set(projEntity.id, projEntity);

      // Emit projectile_spawn event for newly created projectiles
      const numId = entity.id as number;
      if (!ctx.knownProjectileIds.has(numId)) {
        ctx.knownProjectileIds.add(numId);
        const defId = ctx.projectileSystem.getDefId(entity.id);
        if (defId) {
          gameState.events.push({
            type: "projectile_spawn",
            entityId: `proj_${entity.id}`,
            defId,
          });
        }
      }
      continue;
    }

    // Dropped weapon entities (position + weaponMeta for model spawning)
    if (entity.type === EntityType.Item) {
      const itemEntity = new Entity(`item_${entity.id}`);
      if (entity.transform) {
        itemEntity.addComponent("transform", {
          position: {
            x: f32(entity.transform.position.x),
            y: f32(entity.transform.position.y),
            z: f32(entity.transform.position.z),
          },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _transformClone,
        });
        itemEntity.addComponent("position", {
          x: f32(entity.transform.position.x),
          y: f32(entity.transform.position.y),
          z: f32(entity.transform.position.z),
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _shallowClone,
        });
      }
      // Carry weaponId so client can spawn correct model from snapshot data
      const meta = ctx.droppedWeaponSystem.getDroppedWeaponMeta(entity.id);
      if (meta) {
        itemEntity.addComponent("weaponMeta", {
          weaponId: meta.weaponId,
          settled: meta.settled,
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _shallowClone,
        });
      }
      gameState.entities.set(itemEntity.id, itemEntity);
      continue;
    }

    // Skip dead player entity RENDERING DATA — don't send position/velocity
    // (death events handle gibs/kill feed; entity reappears after respawn)
    // BUT still emit combat_state and player state for HUD/scoreboard
    const isDead = !!entity.health?.dead;

    if (!isDead) {
      const clientEntity = new Entity(toClientKey(entity.id));

      if (entity.transform) {
        clientEntity.addComponent("transform", {
          position: {
            x: f32(entity.transform.position.x),
            y: f32(entity.transform.position.y),
            z: f32(entity.transform.position.z),
          },
          rotation: {
            x: f32(entity.transform.rotation.x),
            y: f32(entity.transform.rotation.y),
            z: f32(entity.transform.rotation.z),
            w: 1,
          },
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _transformClone,
        });
        clientEntity.addComponent("position", {
          x: f32(entity.transform.position.x),
          y: f32(entity.transform.position.y),
          z: f32(entity.transform.position.z),
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _shallowClone,
        });
      }

      if (entity.physics) {
        clientEntity.addComponent("velocity", {
          x: f32(entity.physics.velocity.x),
          y: f32(entity.physics.velocity.y),
          z: f32(entity.physics.velocity.z),
          linear: {
            x: f32(entity.physics.velocity.x),
            y: f32(entity.physics.velocity.y),
            z: f32(entity.physics.velocity.z),
          },
          angular: { x: 0, y: 0, z: 0 },
          grounded: entity.physics.grounded,
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _velocityClone,
        });

        clientEntity.addComponent("movementState", {
          isSliding: entity.physics.isSliding ?? false,
          isCrouching: entity.physics.isCrouching ?? false,
          crouchViewOffset: entity.physics.crouchViewOffset ?? 0,
          wallJumpState: entity.physics.wallJumpState ?? "none",
          ledgeGrabState: entity.physics.ledgeGrabState ?? "none",
          actualHorizSpeed: entity.physics.actualHorizSpeed ?? 0,
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _shallowClone,
        });
      }

      // Held powerups, packed to a byte. Public (unlike health/armor): everyone
      // must see who is carrying quad, since the whole counterplay is knowing
      // to avoid — or gang up on — the glowing player.
      if (entity.powerups) {
        clientEntity.addComponent("powerups", {
          mask: packPowerupMask(entity.powerups.expiry, tickNum),
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone: _shallowClone,
        });
      }

      gameState.entities.set(clientEntity.id, clientEntity);
    }

    // Player state (scoreboard + combat_state) — always emit, even for dead players
    if (entity.ownerId !== undefined) {
      const playerId = toClientKey(entity.ownerId);
      // Use entity ID for client entity reference (needed for combat_state)
      const entityClientId = toClientKey(entity.id);
      if (!gameState.players.has(playerId)) {
        // Get score, deaths and team from gametype controller
        const matchState = ctx.gametypeController.getMatchState();
        const score = matchState.getScore(entity.ownerId);
        const deaths = matchState.getDeaths(entity.ownerId);
        const team = matchState.getPlayerTeam(entity.ownerId);

        // Find real player name and ping from client info (O(1) map lookup)
        let displayName = ctx.botNames.get(entity.ownerId) || `Player ${entity.ownerId}`;
        let ping = 0;
        const clientInfo = clientByPlayerId.get(entity.ownerId);
        if (clientInfo) {
          displayName = clientInfo.playerName;
          ping = Math.round(clientInfo.connection.latency ?? 0);
        }

        const playerState: PlayerState = {
          entityId: entityClientId,
          name: displayName,
          team,
          score,
          deaths,
          ping,
          serialize: _noopSerialize,
          deserialize: _noopDeserialize,
          clone() {
            return { ...this, serialize: this.serialize, deserialize: this.deserialize, clone: this.clone };
          },
        };
        gameState.players.set(playerId, playerState);

        // Emit combat_state event (health/armor — private to owning player)
        if (entity.health) {
          gameState.events.push({
            type: "combat_state",
            entityId: entityClientId,
            health: Math.max(0, Math.round(entity.health.health)),
            armor: Math.max(0, Math.round(entity.health.armor)),
            dead: entity.health.dead,
          });
        }

        // Per-powerup countdown for the owner's HUD. The entity mask above says
        // WHO is glowing; this says how long YOURS lasts, so only emit while a
        // timer is actually running.
        if (entity.powerups) {
          for (const kind of POWERUP_KINDS) {
            const remaining = powerupSecondsRemaining(entity.powerups.expiry, kind, tickNum, TICK_RATE);
            if (remaining <= 0) continue;
            gameState.events.push({
              type: "powerup_state",
              entityId: entityClientId,
              kind,
              seconds: Math.ceil(remaining),
            });
          }
        }
      }
    }

    // Emit weapon state for this entity (merged from second pass — avoids double iteration)
    if (entity.ownerId !== undefined) {
      const weaponState = ctx.weaponSystem.getWeaponState(entity.id);
      if (weaponState) {
        gameState.events.push({
          type: "weapon_state",
          entityId: toClientKey(entity.id),
          currentWeapon: weaponState.currentWeapon,
          weapons: weaponState.weapons,
          ammo: Object.fromEntries(weaponState.ammo),
          reloading: weaponState.reloading,
          lastFireTick: weaponState.lastFireTick,
        });
      }
    }
  }

  // Add match state as event (client can read this for HUD). Spectators have
  // no simulation entity, so they never appear in gameState.players — attach a
  // roster here (from the client list) so the scoreboard can list them.
  const matchSnapshot = ctx.gametypeController.getMatchSnapshot();
  const spectators: Array<{ playerId: string; name: string; ping: number }> = [];
  for (const client of ctx.clients.values()) {
    if (client.isSpectator) {
      spectators.push({
        playerId: toClientKey(client.entityId),
        name: client.playerName,
        ping: 0,
      });
    }
  }
  gameState.events.push({
    type: "match_state",
    ...matchSnapshot,
    spectators,
  });

  // Add weapon fire events (so other clients can see shots)
  for (const fireEvent of ctx.weaponSystem.getPendingFireEvents()) {
    gameState.events.push({
      type: "weapon_fire",
      entityId: toClientKey(fireEvent.entityId),
      weaponId: fireEvent.weaponId,
      originX: fireEvent.originX,
      originY: fireEvent.originY,
      originZ: fireEvent.originZ,
      dirX: fireEvent.dirX,
      dirY: fireEvent.dirY,
      dirZ: fireEvent.dirZ,
    });
  }

  // Exact Voltaic damage-ray endpoint. Electrical shape remains client-side.
  for (const beamEvent of ctx.weaponSystem.getPendingVoltaicBeamEvents()) {
    gameState.events.push({
      type: "voltaic_beam",
      entityId: toClientKey(beamEvent.entityId),
      originX: beamEvent.originX,
      originY: beamEvent.originY,
      originZ: beamEvent.originZ,
      dirX: beamEvent.dirX,
      dirY: beamEvent.dirY,
      dirZ: beamEvent.dirZ,
      endX: beamEvent.endX,
      endY: beamEvent.endY,
      endZ: beamEvent.endZ,
      normalX: beamEvent.normalX,
      normalY: beamEvent.normalY,
      normalZ: beamEvent.normalZ,
      impactKind: beamEvent.impactKind,
    });
  }

  // Exact Electrobolt rail endpoint (WO-EB2). Rail presentation stays client-side.
  for (const railEvent of ctx.weaponSystem.getPendingElectroRailEvents()) {
    gameState.events.push({
      type: "electro_rail",
      entityId: toClientKey(railEvent.entityId),
      originX: railEvent.originX,
      originY: railEvent.originY,
      originZ: railEvent.originZ,
      dirX: railEvent.dirX,
      dirY: railEvent.dirY,
      dirZ: railEvent.dirZ,
      endX: railEvent.endX,
      endY: railEvent.endY,
      endZ: railEvent.endZ,
      normalX: railEvent.normalX,
      normalY: railEvent.normalY,
      normalZ: railEvent.normalZ,
      impactKind: railEvent.impactKind,
    });
  }

  // Add chain-lightning arc events (so all clients draw the arcs between targets)
  for (const chainEvent of ctx.weaponSystem.getPendingChainEvents()) {
    gameState.events.push({
      type: "weapon_chain",
      entityId: toClientKey(chainEvent.entityId),
      points: chainEvent.points,
    });
  }

  // Add weapon charge events (so other clients see charge visual)
  for (const chargeEvent of ctx.weaponSystem.getPendingChargeEvents()) {
    gameState.events.push({
      type: "weapon_charge",
      entityId: toClientKey(chargeEvent.entityId),
      weaponId: chargeEvent.weaponId,
      charging: chargeEvent.charging,
    });
  }

  // Add projectile impact events (so all clients see explosions)
  const impacts = ctx.projectileSystem.getPendingImpacts();
  for (const impact of impacts) {
    gameState.events.push({
      type: "projectile_impact",
      defId: impact.defId,
      x: impact.x,
      y: impact.y,
      z: impact.z,
      normalX: impact.normalX,
      normalY: impact.normalY,
      normalZ: impact.normalZ,
    });
  }

  // Authoritative pickup active-set (full mask every snapshot). This is the
  // source of truth for client pickup visibility — convergent and self-healing,
  // unlike the one-shot item_pickup events below.
  gameState.pickupActiveMask = ctx.pickupSystem.getActiveMask();

  // Add pickup events (so clients can sync pickup visibility and weapon changes)
  const pickups = ctx.pickupSystem.getPendingPickupEvents();
  for (const pickup of pickups) {
    gameState.events.push({
      type: "item_pickup",
      pickupId: pickup.pickupId,
      weaponId: pickup.weaponId,
      entityId: pickup.entityId,
      droppedWeaponId: pickup.droppedWeaponId || "",
      x: pickup.x,
      y: pickup.y,
      z: pickup.z,
    });
  }

  // Per-player pickup notifications (labelled) for the HUD toast — fires for
  // weapons/ammo/armor/health. The client shows it only for the local player;
  // captured into demos like every other event.
  for (const notify of ctx.pickupSystem.getPendingPickupNotifies()) {
    gameState.events.push({
      type: "pickup_notify",
      entityId: toClientKey(notify.entityId),
      label: notify.label,
    });
  }

  // Powerup respawned — announced to EVERY client with its world position, so
  // the spawn cue is audible map-wide and players can contest it.
  for (const spawn of ctx.pickupSystem.getPendingPowerupSpawns()) {
    gameState.events.push({
      type: "powerup_spawn",
      kind: spawn.kind,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
    });
  }

  // Inject initial inactive pickup state for newly joined clients
  // (pickups consumed by bots/other players before this client connected)
  if (ctx.needsPickupSync.size > 0) {
    const inactivePickups = ctx.pickupSystem.getInactivePickups();
    if (inactivePickups.length > 0) {
      console.log(
        `[GameServer] Syncing ${inactivePickups.length} inactive pickups to ${ctx.needsPickupSync.size} new client(s)`,
      );
      for (const pickup of inactivePickups) {
        gameState.events.push({
          type: "item_pickup",
          pickupId: pickup.pickupId,
          weaponId: pickup.weaponId,
          entityId: pickup.entityId,
          droppedWeaponId: "",
          x: pickup.x,
          y: pickup.y,
          z: pickup.z,
        });
      }
    }
    ctx.needsPickupSync.clear();
  }

  // Add weapon drop events (so clients can render dropped weapon models)
  for (const dropEvt of ctx.droppedWeaponSystem.getPendingDropEvents()) {
    gameState.events.push({
      type: "weapon_drop",
      entityId: dropEvt.entityId,
      weaponId: dropEvt.weaponId,
      x: dropEvt.x,
      y: dropEvt.y,
      z: dropEvt.z,
      velX: dropEvt.velX,
      velY: dropEvt.velY,
      velZ: dropEvt.velZ,
    });
  }

  // Add damage events (forwarded from CombatSystem for floating damage numbers)
  const damageEvents = ctx.combatSystem.getProcessedDamage();
  for (const dmg of damageEvents) {
    gameState.events.push({
      type: "damage",
      entityId: toClientKey(dmg.victimId),
      attackerId: dmg.attackerId !== undefined ? toClientKey(dmg.attackerId) : "",
      damage: dmg.damage,
      weaponId: dmg.damageType, // Use damageType as weapon identifier for now
      x: dmg.x,
      y: dmg.y,
      z: dmg.z,
    });
  }
  ctx.combatSystem.clearProcessedDamage();

  // Add death events from cached kills (cached before postTick clears them)
  for (const kill of ctx.pendingKillEvents) {
    gameState.events.push({
      type: "death",
      entityId: toClientKey(kill.victimId),
      killerId: kill.killerId !== undefined ? toClientKey(kill.killerId) : "",
      weaponId: kill.damageType, // Use damageType as weapon identifier
      damageType: kill.damageType, // Explicit damage type for gib/ragdoll decision
      finalDamage: kill.finalDamage, // Killing blow damage for gib threshold
      // Victim position + velocity for gib/ragdoll spawning
      x: kill.victimX,
      y: kill.victimY,
      z: kill.victimZ,
      velX: kill.victimVelX,
      velY: kill.victimVelY,
      velZ: kill.victimVelZ,
      // Knockback direction from damage source
      kbDirX: kill.kbDirX,
      kbDirY: kill.kbDirY,
      kbDirZ: kill.kbDirZ,
    });
  }
  // Clear cached kills after they've been sent
  ctx.pendingKillEvents.length = 0;

  // Add chat events (one-shots; recorded into demos automatically post-D16)
  for (const chat of ctx.pendingChatEvents) {
    gameState.events.push({
      type: "chat",
      senderId: chat.senderId,
      senderName: chat.senderName,
      team: chat.team,
      text: chat.text,
    });
  }
  ctx.pendingChatEvents.length = 0;

  // Add award events
  for (const award of ctx.pendingAwards) {
    gameState.events.push({
      type: "award",
      awardType: award.awardType,
      playerId: toClientKey(award.playerId),
      playerName: award.playerName,
      targetName: award.targetName,
      value: award.value,
    });
  }
  ctx.pendingAwards.length = 0;

  return gameState;
}
