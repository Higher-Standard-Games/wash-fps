/**
 * GameEvents — Processes server game state updates and dispatches visual effects.
 *
 * Extracted from Game. Handles:
 * - 12 event types from server snapshots
 * - Weapon state sync (local + remote)
 * - Remote weapon fire effects (hitscan, beams, projectiles)
 * - Projectile entity lifecycle (spawn/despawn/interpolation)
 * - Death logic (gib vs ragdoll decision)
 * - HUD updates (combat state, damage numbers, kill feed)
 */

import { Color3, Vector3 } from "@babylonjs/core";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { CameraSystem } from "../../../engine/camera";
import { NetGraph } from "../../../engine/network/client/NetGraph";
import type { EntitySnapshot, SnapshotBuffer } from "../../../engine/network/client/SnapshotBuffer";
import type { TransformComponent } from "../../../engine/network/components/TransformComponent";
import type { VelocityComponent } from "../../../engine/network/components/VelocityComponent";
import type { GameState } from "../../../engine/network/core/GameState";
import type { IGameHost } from "../../../engine/network/core/IGameHost";
import {
  BLADE_EXPLOSION,
  GRENADE_EXPLOSION,
  getExplosionEffect,
  PLASMA_EXPLOSION,
  ROCKET_EXPLOSION,
} from "../../../engine/weapon/ExplosionEffect";
import { getHitscanEffects } from "../../../engine/weapon/HitscanEffects";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import type { ServerSnapshot, V2NetworkClient } from "../client";
import type { DroppedWeaponInfo, DroppedWeaponRenderer } from "../client/DroppedWeaponRenderer";
import { HUDState } from "../client/HUDState";
import { MatchStateManager } from "../client/MatchStateManager";
import type { RemotePlayerRenderer } from "../client/RemotePlayerRenderer";
import { FPSPlayer } from "../FPSPlayer";
import type { PlayerStateUpdate } from "../Game";
import { WEAPONS } from "../server/weapons/WeaponDef";

/**
 * Mutable context shared with Game.
 * Fields are references (Maps, Sets, arrays) — mutations are visible to both sides.
 */
export interface GameEventContext {
  // Identity
  localPlayerId: string;
  isNetworkMode: boolean;
  gameHost: IGameHost | null;

  // V2 Client (prediction/reconciliation)
  v2Client: V2NetworkClient | null;

  // Renderers (may be lazy-initialized)
  remoteRenderer: RemotePlayerRenderer | null;
  droppedWeaponRenderer: DroppedWeaponRenderer | null;

  // Weapon tracking
  _lastServerWeapon: string | undefined;
  enemyWeapons: Map<string, string>;
  _localCharging: boolean;

  // Charge glow
  chargingPlayers: Set<string>;
  chargingGlows: Map<string, PointLight>;

  // Server projectile tracking
  serverProjectileDefIds: Map<string, string>;
  activeServerProjectiles: Set<string>;
  projectileBuffer: SnapshotBuffer;

  // Death state
  _isPlayerDead: boolean;
  _respawnRequested: boolean;
  _respawnCooldownEnd: number;

  // Lazy effect systems
  _gibSystem: any;
  _pendingGibSpawns: { x: number; y: number; z: number; vx: number; vy: number; vz: number }[];
  _ragdollSystem: any;
  _cartoonHit: any;

  // State update dispatch
  onStateUpdateCallbacks: ((state: PlayerStateUpdate) => void)[];
  pendingTick: number;

  // Tab recovery
  _tabReturnFrameSkips: number;

  // Diagnostic
  _stateUpdateCount: number;

  // Methods to call back into Game
  sendRequestSpawn(): void;
}

/** Color palette per weapon ID (Warsow-inspired) */
const WEAPON_EFFECT_COLORS: Record<string, [number, number, number]> = {
  machinegun: [1.0, 0.9, 0.3], // warm yellow
  riotgun: [1.0, 0.6, 0.2], // orange
  voltaic: [1.0, 0.7, 0.1], // warm orange (beam)
  electrobolt: [0.3, 0.6, 1.0], // blue
  instagun: [0.8, 0.2, 1.0], // purple
};

/**
 * Process a server state update: dispatch events, sync weapon state,
 * buffer snapshots, update HUD, and feed V2Client.
 */
export function handleServerStateUpdate(ctx: GameEventContext, state: GameState): void {
  ctx._stateUpdateCount++;

  // Record snapshot for NetGraph
  const localPlayer = state.players.get(ctx.localPlayerId);
  NetGraph.recordSnapshot(localPlayer?.ping ?? 0, state.tick);

  // Feed ClockSync offset to NetGraph for display
  const networkHost = ctx.gameHost as any;
  if (networkHost?.clockSync?.isSynced()) {
    NetGraph.setClockOffset(networkHost.clockSync.getOffset());
  }

  // Dynamically sync localPlayerId from the game host.
  if (ctx.gameHost && ctx.localPlayerId !== ctx.gameHost.localPlayerId) {
    ctx.localPlayerId = ctx.gameHost.localPlayerId;
  }

  // Process match_state events before anything else
  const localEntityId = state.players.get(ctx.localPlayerId)?.entityId;

  if (state.events && state.events.length > 0) {
    const matchMgr = MatchStateManager.getInstance();

    for (const event of state.events) {
      if (event.type === "match_state") {
        matchMgr.processEvent(event);
      } else if (event.type === "weapon_state" && event.entityId === localEntityId) {
        handleWeaponStateSync(ctx, event);
      } else if (event.type === "weapon_state" && event.entityId !== localEntityId) {
        if (event.currentWeapon) {
          ctx.enemyWeapons.set(event.entityId, event.currentWeapon);
        }
      } else if (event.type === "weapon_fire") {
        if (event.entityId === localEntityId) {
          const wvm = getWeaponViewManager();
          const isProjectileFire = ctx._localCharging;
          if (ctx._localCharging) ctx._localCharging = false;
          wvm.fire({ isProjectileFire });
        } else {
          handleRemoteWeaponFire(ctx, event);
        }
      } else if (event.type === "weapon_charge") {
        if (event.entityId === localEntityId) {
          ctx._localCharging = event.charging;
        } else {
          if (event.charging) {
            ctx.chargingPlayers.add(event.entityId);
          } else {
            ctx.chargingPlayers.delete(event.entityId);
            const glow = ctx.chargingGlows.get(event.entityId);
            if (glow) {
              glow.dispose();
              ctx.chargingGlows.delete(event.entityId);
            }
          }
        }
      } else if (event.type === "projectile_impact") {
        const pos = new Vector3(event.x, event.y, event.z);
        const projDefId =
          event.defId === "glauncher"
            ? "grenade"
            : event.defId === "plasmagun"
              ? "plasma_bolt"
              : event.defId === "rlauncher"
                ? "rocket"
                : event.defId;

        if (getProjectileManager().hasRecentPrediction(pos, projDefId)) {
          continue;
        }

        const normal = new Vector3(event.normalX, event.normalY, event.normalZ);
        const config =
          event.defId === "glauncher"
            ? GRENADE_EXPLOSION
            : event.defId === "plasmagun"
              ? PLASMA_EXPLOSION
              : event.defId === "blade_blast"
                ? BLADE_EXPLOSION
                : ROCKET_EXPLOSION;
        getExplosionEffect().spawn(pos, config, normal);
      } else if (event.type === "item_pickup") {
        import("../../../engine/game/Pickup").then(({ Pickup }) => {
          Pickup.deactivateById(event.pickupId, event.weaponId, event.x, event.y, event.z);
        });
      } else if (event.type === "projectile_spawn") {
        ctx.serverProjectileDefIds.set(event.entityId, event.defId);
      } else if (event.type === "combat_state" && event.entityId === localEntityId) {
        HUDState.getInstance().processCombatState(event);
        if (event.dead && !ctx._isPlayerDead) {
          ctx._isPlayerDead = true;
          ctx._respawnRequested = false;
          ctx._respawnCooldownEnd = Date.now() + 3000;
          console.log("[GameEvents] Local player died");
          import("../../../engine/weapon/WeaponViewManager").then((m) => {
            m.getWeaponViewManager().setVisible(false);
          });
        } else if (!event.dead && ctx._isPlayerDead) {
          ctx._isPlayerDead = false;
          ctx._respawnRequested = false;
          console.log("[GameEvents] Local player respawned");
          if (ctx.v2Client) {
            ctx.v2Client.resetForRespawn();
          }
          import("../../../engine/weapon/WeaponViewManager").then((m) => {
            m.getWeaponViewManager().setVisible(true);
          });
        }
      } else if (event.type === "combat_state" && event.entityId !== localEntityId) {
        if (!event.dead && ctx.remoteRenderer) {
          ctx.remoteRenderer.markAlive(event.entityId);
        }
      } else if (event.type === "damage") {
        HUDState.getInstance().processDamage(event);

        // === INCOMING DAMAGE: local player is the victim ===
        if (event.entityId === localEntityId && event.damage > 0) {
          // Compute direction angle from attacker to local player
          let damageAngle = Math.random() * Math.PI * 2; // fallback: random

          if (event.attackerId && event.attackerId !== localEntityId) {
            // Get attacker position from state entities
            const attackerEntity = state.entities.get(event.attackerId);
            const attackerPos = attackerEntity?.getComponent("position") as
              | { x: number; y: number; z: number }
              | undefined;
            const localEntity = state.entities.get(localEntityId || "");
            const localPos = localEntity?.getComponent("position") as { x: number; y: number; z: number } | undefined;

            if (attackerPos && localPos) {
              // World-space direction from attacker to victim
              const worldDx = attackerPos.x - localPos.x;
              const worldDz = attackerPos.z - localPos.z;
              const worldAngle = Math.atan2(worldDz, worldDx);

              // Get camera yaw to convert to screen-space
              const cam = CameraSystem.getInstance().getCamera() as any;
              const cameraYaw = cam?.rotation?.y ?? 0;

              // Screen-space angle: positive X = right, positive Y = down
              damageAngle = worldAngle - cameraYaw;
            }
          }

          // Trigger damage overlay (directional red triangles + vignette)
          import("../../../engine/ui/hud/DamageOverlay").then((m) => {
            m.DamageOverlay.getInstance().show(event.damage, damageAngle);
          });

          // Trigger pain camera shake (all weapon types)
          const painIntensity = Math.min(Math.max(event.damage / 100, 0.05), 0.6);
          const fpsCtrl = CameraSystem.getInstance().getController("fps");
          if (fpsCtrl && "shakeCamera" in fpsCtrl) {
            (fpsCtrl as any).shakeCamera(painIntensity);
          }
        }

        // === OUTGOING DAMAGE: local player is the attacker ===
        if (event.attackerId && event.attackerId === localEntityId) {
          import("../client/Crosshair").then((m) => m.Crosshair.getInstance().notifyHit());
          if (event.x !== undefined && event.damage > 0) {
            import("../client/DamageNumbers").then((m) => {
              const dn = m.DamageNumbers.getInstance();
              if (!(dn as any)["scene"]) {
                const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
                if (gameScene) dn.init(gameScene);
              }
              dn.spawn(event.x, event.y, event.z, event.damage);
            });
          }
          if (event.x !== undefined && ctx._cartoonHit) {
            ctx._cartoonHit.spawn(event.x, event.y, event.z, event.damage);
          }
        }
      } else if (event.type === "death") {
        handleDeathEvent(ctx, event, localEntityId, state);
      } else if (event.type === "weapon_drop") {
        handleWeaponDrop(ctx, event);
      } else if (event.type === "award") {
        handleAwardEvent(ctx, event);
      }
    }
  }

  // === Update charge glow positions from entity data ===
  if (ctx.chargingPlayers.size > 0) {
    const scene = CameraSystem.getInstance().getCamera()?.getScene();
    if (scene) {
      for (const entityId of ctx.chargingPlayers) {
        const entity = state.entities.get(entityId);
        const pos = entity?.getComponent("position") as { x: number; y: number; z: number } | undefined;
        if (pos) {
          let light = ctx.chargingGlows.get(entityId);
          if (!light) {
            light = new PointLight(`charge_glow_${entityId}`, new Vector3(pos.x, pos.y + 30, pos.z), scene);
            light.diffuse = new Color3(1.0, 0.15, 0.05);
            light.specular = new Color3(1.0, 0.1, 0.0);
            light.range = 60;
            light.intensity = 8;
            ctx.chargingGlows.set(entityId, light);
          }
          light.position.set(pos.x, pos.y + 30, pos.z);
        }
      }
    }
  }

  // Update HUD state aggregator
  const hudState = HUDState.getInstance();
  hudState.localPlayerId = ctx.localPlayerId;
  hudState.updateScoreboard(state);
  hudState.expireTransients();
  hudState.updateDebugOverlay();

  // === Remote player snapshot buffering ===
  if (ctx.remoteRenderer) {
    let serverLocalTime: number | undefined;
    const nh = ctx.gameHost as any;
    if (state.serverTimestamp && nh?.clockSync?.isSynced()) {
      serverLocalTime = nh.clockSync.toLocalTime(state.serverTimestamp);
    }
    ctx.remoteRenderer.pushSnapshot(state, localEntityId || "", serverLocalTime);
  }

  // === Dropped weapon entity sync (entity-driven: spawn/position/dispose from snapshot data) ===
  {
    // Lazy-init: create renderer on first item_ entity sight (covers late-join + event timing)
    let hasItemEntities = false;
    if (!ctx.droppedWeaponRenderer) {
      for (const id of state.entities.keys()) {
        if (id.startsWith("item_")) {
          hasItemEntities = true;
          break;
        }
      }
      if (hasItemEntities) {
        const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
        if (gameScene) {
          // Synchronous import — DroppedWeaponRenderer is a small file, already bundled
          import("../client/DroppedWeaponRenderer").then(({ DroppedWeaponRenderer }) => {
            if (!ctx.droppedWeaponRenderer && gameScene) {
              ctx.droppedWeaponRenderer = new DroppedWeaponRenderer(gameScene);
            }
          });
        }
      }
    }
    if (ctx.droppedWeaponRenderer) {
      const itemEntities = new Map<string, DroppedWeaponInfo>();
      for (const [id, entity] of state.entities) {
        if (id.startsWith("item_")) {
          const t = entity.getComponent("transform") as any;
          const wm = entity.getComponent("weaponMeta") as any;
          if (t?.position) {
            itemEntities.set(id, {
              x: t.position.x,
              y: t.position.y,
              z: t.position.z,
              weaponId: wm?.weaponId,
              settled: wm?.settled ?? false,
            });
          }
        }
      }
      ctx.droppedWeaponRenderer.syncServerEntities(itemEntities);
    }
  }

  // === Server-driven projectile entity processing (Q3-style) ===
  processProjectileEntities(ctx, state);

  // === Local player position update ===
  const player = state.players.get(ctx.localPlayerId);
  if (!player) return;

  const entity = state.entities.get(player.entityId);
  if (!entity) return;

  const transform = entity.getComponent<TransformComponent>("transform");
  const velocity = entity.getComponent<VelocityComponent>("velocity");
  if (!transform || !velocity) return;

  const physics = velocity as any;

  // === V2 CLIENT: Buffer snapshot for frame-synchronized processing ===
  if (ctx.v2Client && ctx.isNetworkMode) {
    const snapshot: ServerSnapshot = {
      tick: state.tick,
      ackedInputSeq: state.ackedInputSeq,
      position: { ...transform.position },
      velocity: { ...velocity.linear },
      grounded: velocity.grounded,
    };
    ctx.v2Client.bufferSnapshot(snapshot);
    ctx.pendingTick = state.tick;
    return;
  }

  const update: PlayerStateUpdate = {
    position: { ...transform.position },
    velocity: { ...velocity.linear },
    grounded: velocity.grounded,
    tick: state.tick,
    isSliding: physics.isSliding ?? false,
    isCrouching: physics.isCrouching ?? false,
    crouchViewOffset: physics.crouchViewOffset ?? 0,
    wallJumpState: physics.wallJumpState ?? "none",
    ledgeGrabState: physics.ledgeGrabState ?? "none",
    actualHorizSpeed: physics.actualHorizSpeed ?? 0,
    slidePhase: physics.slidePhase ?? 0,
    ledgeGrabPhase: physics.ledgeGrabPhase ?? 0,
  };

  for (const callback of ctx.onStateUpdateCallbacks) {
    callback(update);
  }
}

// ── Internal helpers ───────────────────────────────────────────────

function handleDeathEvent(
  ctx: GameEventContext,
  event: any,
  localEntityId: string | undefined,
  state: GameState,
): void {
  console.log(
    `[Death] Event received: entity=${event.entityId} killer=${event.killerId} damageType=${event.damageType} finalDamage=${event.finalDamage} pos=(${event.x}, ${event.y}, ${event.z})`,
  );
  try {
    HUDState.getInstance().processDeath(event);
  } catch (e) {
    console.error("[Death] HUD processDeath error:", e);
  }

  // Push kill message to EventFeed
  try {
    const victimName = resolvePlayerName(event.entityId, state) || "unknown";
    const killerName = event.killerId ? resolvePlayerName(event.killerId, state) : null;
    if (killerName && event.killerId !== event.entityId) {
      import("../../../engine/ui/hud/EventFeed").then((m) => {
        m.EventFeed.getInstance().addKill(killerName, victimName, event.damageType);
      });
    }
  } catch (e) {
    console.error("[Death] EventFeed error:", e);
  }

  const damageType = event.damageType || event.weaponId || "";
  const finalDamage = event.finalDamage || 0;
  const shouldGib = damageType === "rail" || (damageType === "explosion" && finalDamage >= 50);

  if (shouldGib) {
    try {
      if (ctx.remoteRenderer && event.entityId) {
        ctx.remoteRenderer.markDead(event.entityId);
      }
    } catch (e) {
      console.error("[Death] markDead error:", e);
    }
    if (event.x !== undefined) {
      console.log(`[GibSystem] Gib death: dmgType=${damageType} dmg=${finalDamage}`);
      if (ctx._gibSystem) {
        ctx._gibSystem.spawn(event.x, event.y, event.z, event.velX || 0, event.velY || 0, event.velZ || 0);
      } else {
        ctx._pendingGibSpawns.push({
          x: event.x,
          y: event.y,
          z: event.z,
          vx: event.velX || 0,
          vy: event.velY || 0,
          vz: event.velZ || 0,
        });
      }
    }
  } else {
    console.log(`[RagdollSystem] Ragdoll death: dmgType=${damageType} dmg=${finalDamage}`);
    let model = null;
    try {
      if (ctx.remoteRenderer && event.entityId) {
        model = ctx.remoteRenderer.detachModel(event.entityId);
      }
    } catch (e) {
      console.error("[Death] detachModel error:", e);
    }

    if (model && ctx._ragdollSystem) {
      ctx._ragdollSystem.spawn(model, event.kbDirX || 0, event.kbDirY || 0, event.kbDirZ || 0);
    } else if (model) {
      console.warn("[Death] RagdollSystem not ready, falling back to gibs");
      if (model.mesh) model.mesh.dispose();
      if (model.skeleton) model.skeleton.dispose();
      if (model.anchor) model.anchor.dispose();
      if (event.x !== undefined && ctx._gibSystem) {
        ctx._gibSystem.spawn(event.x, event.y, event.z, event.velX || 0, event.velY || 0, event.velZ || 0);
      }
    } else {
      try {
        if (ctx.remoteRenderer && event.entityId) {
          ctx.remoteRenderer.markDead(event.entityId);
        }
      } catch {
        /* noop */
      }
    }
  }
}

function handleWeaponDrop(ctx: GameEventContext, event: any): void {
  // Capture velocity from weapon_drop event for Havok physics.
  // The entity-driven system spawns the visual when the item_ entity
  // appears in snapshot, but needs the initial toss velocity from this event.
  const gameScene = CameraSystem.getInstance().getCamera()?.getScene();

  // Lazy-init renderer
  if (!ctx.droppedWeaponRenderer && gameScene) {
    import("../client/DroppedWeaponRenderer").then(({ DroppedWeaponRenderer }) => {
      if (!ctx.droppedWeaponRenderer && gameScene) {
        ctx.droppedWeaponRenderer = new DroppedWeaponRenderer(gameScene);
      }
      // Stash velocity for when entity appears in snapshot
      if (ctx.droppedWeaponRenderer && event.entityId) {
        const vel = new Vector3(event.velX || 0, event.velY || 0, event.velZ || 0);
        ctx.droppedWeaponRenderer.stashVelocity(event.entityId, vel);
      }
    });
    return;
  }

  // Stash velocity for Havok body creation
  if (ctx.droppedWeaponRenderer && event.entityId) {
    const vel = new Vector3(event.velX || 0, event.velY || 0, event.velZ || 0);
    ctx.droppedWeaponRenderer.stashVelocity(event.entityId, vel);
  }
}

/**
 * Handle weapon_state event from server for the local player.
 * Syncs the client's inventory and weapon view with server state.
 */
function handleWeaponStateSync(ctx: GameEventContext, event: any): void {
  const player = FPSPlayer.getInstance();
  if (!player) return;

  const serverWeapon = event.currentWeapon as string;
  const serverWeapons = event.weapons as string[];
  const serverAmmo = event.ammo as Record<string, number>;

  player.inventory.syncFromServer(serverWeapons, serverAmmo, serverWeapon);

  // Sync weapon speed bonus to client-side prediction
  const weaponDef = WEAPONS[serverWeapon];
  if (ctx.v2Client) {
    ctx.v2Client.setSpeedBonus(weaponDef?.speedBonus ?? 0);
  }

  if (event.reloading !== undefined) {
    player.setServerReloadState(event.reloading as boolean);
  }
  if (event.lastFireTick !== undefined) {
    player.syncFireTiming(event.lastFireTick as number);
  }

  // Keep FPSController's currentWeaponSlot in sync with server
  const slotIndex = serverWeapons.indexOf(serverWeapon);
  if (slotIndex >= 0) {
    player.getController().currentWeaponSlot = slotIndex;
  }

  // Update HUD
  const hudState = HUDState.getInstance();
  hudState.processWeaponState({
    currentWeapon: serverWeapon,
    weapons: serverWeapons,
    ammo: serverAmmo,
  });

  // Detect weapon change
  if (serverWeapon !== ctx._lastServerWeapon) {
    const isFirstWeapon = ctx._lastServerWeapon === undefined;
    const wvm = getWeaponViewManager();

    if (!wvm.isReady) return;

    console.log(`[GameEvents] Server weapon changed: ${ctx._lastServerWeapon || "none"} → ${serverWeapon}`);
    ctx._lastServerWeapon = serverWeapon;

    if (isFirstWeapon) {
      wvm.loadWeapon(serverWeapon).catch((err) => {
        console.error(`[GameEvents] Failed to load initial weapon: ${serverWeapon}`, err);
      });
    } else {
      wvm.switchWeaponAnimated(serverWeapon).catch((err) => {
        console.error(`[GameEvents] Failed to switch weapon: ${serverWeapon}`, err);
      });
    }
  }
}

/**
 * Spawn visual effects for another player's weapon fire.
 */
function handleRemoteWeaponFire(ctx: GameEventContext, event: any): void {
  const fx = getHitscanEffects();
  const projMgr = getProjectileManager();

  if (!projMgr["scene"]) {
    const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
    if (gameScene) projMgr.init(gameScene);
  }

  const origin = new Vector3(event.originX, event.originY, event.originZ);
  const dir = new Vector3(event.dirX, event.dirY, event.dirZ);
  const rgb = WEAPON_EFFECT_COLORS[event.weaponId];
  const color = rgb ? new Color3(rgb[0], rgb[1], rgb[2]) : new Color3(1, 1, 0.5);

  switch (event.weaponId) {
    case "machinegun":
      fx.fireTracer({ origin, direction: dir, color, maxRange: 6000 });
      break;
    case "riotgun":
      fx.firePellets({
        origin,
        direction: dir,
        color,
        pelletCount: 20,
        spreadAngle: 12,
        maxRange: 8192,
      });
      break;
    case "voltaic":
      fx.updateRemoteBeam(event.entityId, {
        origin,
        direction: dir,
        color,
        maxRange: 850,
        diameterStart: 0.6,
        diameterEnd: 0.15,
      });
      break;
    case "electrobolt":
    case "instagun":
      fx.fireBolt({ origin, direction: dir, color, maxRange: 10000 });
      break;
    case "plasmagun":
    case "rlauncher":
    case "glauncher":
    case "gunblade":
      break;
    case "blade":
      ctx.remoteRenderer?.playAttackAnim(event.entityId, "blade_slash", 2.0);
      break;
    default:
      fx.fireTracer({ origin, direction: dir, color, maxRange: 5000 });
      break;
  }
}

/**
 * Process server-driven projectile entities (Q3-style spawn/despawn/interpolation).
 */
function processProjectileEntities(ctx: GameEventContext, state: GameState): void {
  const projEntities = new Map<string, EntitySnapshot>();
  const aliveThisSnapshot = new Set<string>();

  for (const [entityId, entity] of state.entities) {
    if (!entityId.startsWith("proj_")) continue;
    aliveThisSnapshot.add(entityId);

    const posComp = entity.getComponent("position") as any;
    const velComp = entity.getComponent("velocity") as any;
    if (!posComp) continue;

    projEntities.set(entityId, {
      x: posComp.x,
      y: posComp.y,
      z: posComp.z,
      yaw: 0,
      vx: velComp?.x ?? 0,
      vy: velComp?.y ?? 0,
      vz: velComp?.z ?? 0,
      grounded: false,
      crouching: false,
      sliding: false,
    });

    if (!ctx.activeServerProjectiles.has(entityId)) {
      const defId = ctx.serverProjectileDefIds.get(entityId);
      if (defId) {
        const projMgr = getProjectileManager();
        if (!projMgr["scene"]) {
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) projMgr.init(gameScene);
        }
        const pos = new Vector3(posComp.x, posComp.y, posComp.z);
        const vel = velComp ? new Vector3(velComp.x, velComp.y, velComp.z) : Vector3.Zero();
        projMgr.spawnFromServer(entityId, defId, pos, vel);
        ctx.activeServerProjectiles.add(entityId);
      }
    }
  }

  // Push to interpolation buffer
  let serverLocalTime: number | undefined;
  const nh = ctx.gameHost as any;
  if (state.serverTimestamp && nh?.clockSync?.isSynced()) {
    serverLocalTime = nh.clockSync.toLocalTime(state.serverTimestamp);
  }
  ctx.projectileBuffer.push(state.tick, projEntities, serverLocalTime);

  // Despawn visuals for projectiles that disappeared
  for (const entityId of ctx.activeServerProjectiles) {
    if (!aliveThisSnapshot.has(entityId)) {
      getProjectileManager().despawnByEntityId(entityId);
      ctx.activeServerProjectiles.delete(entityId);
      ctx.serverProjectileDefIds.delete(entityId);
    }
  }
}

// ── Award Event Handler ────────────────────────────────────────────

function handleAwardEvent(ctx: GameEventContext, event: any): void {
  const awardType: string = event.awardType || "";
  const playerId: string = event.playerId || "";
  const playerName: string = event.playerName || "";
  const targetName: string = event.targetName || "";

  console.log(`[Award] ${playerName}: ${awardType} (target=${targetName}, value=${event.value})`);
  console.log(`[Award] Compare: event.playerId='${playerId}' ctx.localPlayerId='${ctx.localPlayerId}'`);

  // Match against multiple ID formats since server/client may use different formats
  const isLocalPlayer =
    playerId === ctx.localPlayerId ||
    playerId === `player_${ctx.localPlayerId}` ||
    `player_${playerId}` === ctx.localPlayerId;

  // Personal award banner (only for local player)
  if (isLocalPlayer) {
    import("../../../engine/ui/hud/AwardBanner").then((m) => {
      m.AwardBanner.getInstance().show(awardType, playerName, targetName);
    });
  }

  // Global event feed (everyone sees streak/first blood awards, skip frag spam)
  if (awardType !== "frag") {
    import("../../../engine/ui/hud/EventFeed").then((m) => {
      m.EventFeed.getInstance().addAward(playerName, awardType, event.value || 0);
    });
  }
}

// ── Name Resolution Helper ─────────────────────────────────────────

/**
 * Resolve a player entity ID (e.g., 'player_3') to a display name
 * by looking up the GameState.players map.
 */
function resolvePlayerName(entityId: string, state: GameState): string {
  // Try direct match via players map (keyed by 'player_N' where N is ownerId)
  for (const [_pid, player] of state.players) {
    if (player.entityId === entityId) {
      return player.name;
    }
  }
  // Fallback: strip prefix
  return entityId?.replace("player_", "Player ") || "unknown";
}
