/**
 * SnapshotBuilder — Converts server simulation state to a GameState for network transmission.
 *
 * Pure(-ish) data transformation extracted from GameServer. Takes simulation state
 * and subsystem references via a SnapshotContext, returns a wire-ready GameState.
 *
 * Side effects: tracks known projectile IDs, clears pending events from subsystems.
 */

import type { Simulation } from "@engine/server/core/Simulation";
import type { EntityId, PlayerId } from "@engine/server/ecs/types";
import { EntityType } from "@engine/server/ecs/types";
import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "@shared/server/simulation/physics/constants";
import { Entity } from "../../../engine/network/core/Entity";
import { GameState, type PlayerState } from "../../../engine/network/core/GameState";
import type { SnapshotEvent } from "../../../engine/network/core/SnapshotEvent";
import { POWERUP_KINDS, packPowerupMask, powerupSecondsRemaining } from "../../../shared/items/Powerups";
import { MatchPhase } from "../../../shared/server/gametype";
import { toClientKey } from "../ClientEntityKey";
import type { PendingChatEvent, ScopedChatEvent } from "./ChatRouting";
import type { ClientInfo } from "./Client";
import type { AwardEvent } from "./gametypes/AwardTracker";
import type { GametypeController } from "./gametypes/GametypeController";
import type { CombatSystem, KillEvent } from "./systems/CombatSystem";
import type { DroppedWeaponSystem } from "./systems/DroppedWeaponSystem";
import type { FPSMovementSubsystem } from "./systems/FPSMovementSubsystem";
import type { PickupSystem } from "./systems/PickupSystem";
import type { ProjectileSystem } from "./systems/ProjectileSystem";
import type { WeaponSystem } from "./systems/WeaponSystem";

// ── Hoisted closures (same pattern as BinaryProtocol decode side) ──
// These are no-op stubs shared by all components to avoid per-entity allocations.
const _noopSerialize = () => ({});
const _noopDeserialize = () => {
  /* no-op */
};
interface XYZ {
  x: number;
  y: number;
  z: number;
}
function _shallowClone<T extends object>(this: T): T {
  return { ...this };
}
function _transformClone(this: { position: XYZ; rotation: XYZ & { w: number } }) {
  return {
    position: { ...this.position },
    rotation: { ...this.rotation },
    serialize: _noopSerialize,
    deserialize: _noopDeserialize,
    clone: _transformClone,
  };
}
function _velocityClone(this: XYZ & { linear: XYZ; angular: XYZ; grounded: boolean }) {
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
  collisionWorld?: import("../../../shared/collision/CollisionWorld").CollisionWorld | null;
  simulation: Simulation;
  movementSystem?: Pick<FPSMovementSubsystem, "getKnockbackAge">;
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
  pendingChatEvents: PendingChatEvent[];
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
/** Warsow's pain levels by remaining health: 0 at 20 or less, 1 up to 35, 2 up to 60, 3 above. */
export function painTier(health: number): 0 | 1 | 2 | 3 {
  return health <= 20 ? 0 : health <= 35 ? 1 : health <= 60 ? 2 : 3;
}

export function buildSnapshot(ctx: SnapshotContext): GameState {
  const state = ctx.simulation.getState();
  const gameState = new GameState();
  // Every event goes through the same union the client dispatches on, so a misspelt
  // or missing field is a compile error here rather than a silent miss on the client.
  const emit = (event: SnapshotEvent) => gameState.events.push(event);
  gameState.tick = Number(state.tick);
  const tickNum = gameState.tick;
  const lifts = ctx.collisionWorld?.lifts;
  // lift_state is not in the SnapshotEvent union (the client reads it outside the event switch).
  if (lifts?.definitions.length) gameState.events.push({ type: "lift_state", lifts: lifts.snapshot() });

  // Build O(1) player-to-client lookup map (avoids O(clients) scan per entity)
  const clientByPlayerId = new Map<PlayerId, ClientInfo>();
  for (const client of ctx.clients.values()) {
    if (client.playerId !== undefined) {
      clientByPlayerId.set(client.playerId, client);
    }
  }

  // Forget projectiles that no longer exist. Entity ids are never reused, so an id
  // that is gone is gone for good; keeping it would grow this set for the whole match.
  for (const id of ctx.knownProjectileIds) {
    if (!state.getEntity(id as EntityId)) ctx.knownProjectileIds.delete(id);
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
          emit({
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
          strafeInput: entity.physics.strafeInput ?? 0,
          forwardInput: entity.physics.forwardInput ?? 0,
          slidePhase: entity.physics.slidePhase ?? 0,
          ledgeGrabPhase: entity.physics.ledgeGrabPhase ?? 0,
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
      // Repeated state, including null: loss of the impulse/cancel snapshot must
      // self-heal. Position/velocity already include all impulses through this tick.
      emit({
        type: "knockback_state",
        entityId: entityClientId,
        ageTicks: isDead ? null : (ctx.movementSystem?.getKnockbackAge(Number(entity.id)) ?? null),
      });
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
          ping = Math.round(clientInfo.ping);
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
          emit({
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
            emit({
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
        emit({
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
  // Final standings, from the match's own tally rather than from entities.
  // Built for everyone who took part, spectators included, because a player who
  // went to spectate mid-match still earned their score — and at match end the
  // whole lobby is flagged as spectating anyway.
  const matchState = ctx.gametypeController.getMatchState();
  const standings: Array<{
    playerId: string;
    name: string;
    score: number;
    frags: number;
    deaths: number;
    ping: number;
  }> = [];
  for (const client of ctx.clients.values()) {
    if (client.playerId === undefined) continue;
    standings.push({
      playerId: toClientKey(client.entityId),
      name: client.playerName,
      score: matchState.getScore(client.playerId),
      frags: matchState.getStats(client.playerId).frags,
      deaths:
        matchState.phase === MatchPhase.PostGame
          ? matchState.getStats(client.playerId).deaths
          : matchState.getDeaths(client.playerId),
      ping: client.connection?.latency ?? 0,
    });
  }

  emit({
    type: "match_state",
    ...matchSnapshot,
    standings,
    spectators,
  });

  // Add weapon fire events (so other clients can see shots)
  for (const fireEvent of ctx.weaponSystem.getPendingFireEvents()) {
    emit({
      type: "weapon_fire",
      entityId: toClientKey(fireEvent.entityId),
      weaponId: fireEvent.weaponId,
      originX: fireEvent.originX,
      originY: fireEvent.originY,
      originZ: fireEvent.originZ,
      dirX: fireEvent.dirX,
      dirY: fireEvent.dirY,
      dirZ: fireEvent.dirZ,
      ...(fireEvent.pelletSeed !== undefined
        ? { pelletSeed: fireEvent.pelletSeed, pelletSpread: fireEvent.pelletSpread }
        : {}),
    });
  }

  // Exact Voltaic damage-ray endpoint. Electrical shape remains client-side.
  for (const beamEvent of ctx.weaponSystem.getPendingVoltaicBeamEvents()) {
    emit({
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
    emit({
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
    emit({
      type: "weapon_chain",
      entityId: toClientKey(chainEvent.entityId),
      points: chainEvent.points,
    });
  }

  // Add weapon charge events (so other clients see charge visual)
  for (const chargeEvent of ctx.weaponSystem.getPendingChargeEvents()) {
    emit({
      type: "weapon_charge",
      entityId: toClientKey(chargeEvent.entityId),
      weaponId: chargeEvent.weaponId,
      charging: chargeEvent.charging,
    });
  }

  // Add projectile impact events (so all clients see explosions)
  const impacts = ctx.projectileSystem.getPendingImpacts();
  for (const impact of impacts) {
    emit({
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
    emit({
      type: "item_pickup",
      pickupId: pickup.pickupId,
      weaponId: pickup.weaponId,
      entityId: String(pickup.entityId), // the picker's numeric id; the wire carries a string
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
    emit({
      type: "pickup_notify",
      entityId: toClientKey(notify.entityId),
      label: notify.label,
    });
  }

  // Powerup respawned — announced to EVERY client with its world position, so
  // the spawn cue is audible map-wide and players can contest it.
  for (const spawn of ctx.pickupSystem.getPendingPowerupSpawns()) {
    emit({
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
        emit({
          type: "item_pickup",
          pickupId: pickup.pickupId,
          weaponId: pickup.weaponId,
          entityId: String(pickup.entityId), // the picker's numeric id; the wire carries a string
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
    emit({
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
    const victimHealth = state.getEntity(dmg.victimId)?.health;
    emit({
      type: "damage",
      entityId: toClientKey(dmg.victimId),
      attackerId: dmg.attackerId !== undefined ? toClientKey(dmg.attackerId) : "",
      damage: dmg.damage,
      // Where the hit landed ("body", "head" or "legs"). The wire format carries it once the
      // engine's damage event does; until then the codec leaves it out and clients assume body.
      hitLocation: dmg.hitLocation,
      // How hurt the victim is after this tick's hits, for their pain sound
      painTier: victimHealth ? painTier(victimHealth.health) : undefined,
      weaponId: dmg.damageType, // Use damageType as weapon identifier for now
      x: dmg.x,
      y: dmg.y,
      z: dmg.z,
    });
  }
  ctx.combatSystem.clearProcessedDamage();

  // Add death events from cached kills (cached before postTick clears them)
  for (const kill of ctx.pendingKillEvents) {
    emit({
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
    const event: ScopedChatEvent = { type: "chat", ...chat };
    emit(event);
  }
  ctx.pendingChatEvents.length = 0;

  // Add award events
  for (const award of ctx.pendingAwards) {
    emit({
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
