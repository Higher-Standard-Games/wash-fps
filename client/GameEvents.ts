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

import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CameraSystem } from "../../../engine/camera";
import { addToDynamicLightCluster, disposeClusteredLight } from "../../../engine/lighting/DynamicLightCluster";
import { NetGraph } from "../../../engine/network/client/NetGraph";
import type { EntitySnapshot, SnapshotBuffer } from "../../../engine/network/client/SnapshotBuffer";
import type { TransformComponent } from "../../../engine/network/components/TransformComponent";
import type { VelocityComponent } from "../../../engine/network/components/VelocityComponent";
import type { GameState } from "../../../engine/network/core/GameState";
import type { IGameHost } from "../../../engine/network/core/IGameHost";
import {
  assertUnroutedEvent,
  type ElectroRailEvent,
  type SnapshotEvent,
  type VoltaicBeamEvent,
} from "../../../engine/network/core/SnapshotEvent";
import {
  BLADE_EXPLOSION,
  GRENADE_EXPLOSION,
  getExplosionEffect,
  PLASMA_EXPLOSION,
  ROCKET_EXPLOSION,
} from "../../../engine/weapon/ExplosionEffect";
import { getHitscanEffects, type VoltaicBeamTruthConfig } from "../../../engine/weapon/HitscanEffects";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import type { RailEffectSample } from "../../../engine/weapon/rail/RailProfiles";
import { getWeaponViewManager } from "../../../engine/weapon/WeaponViewManager";
import { canonicalWeaponId, WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import { toClientKey } from "../ClientEntityKey";
import type { ServerSnapshot, V2NetworkClient } from "../client";
import type { DroppedWeaponInfo, DroppedWeaponRenderer } from "../client/DroppedWeaponRenderer";
import {
  playDamageConfirmationSound,
  playKillEcho,
  playPlayerDeathSound,
  playPlayerPainSound,
  playProjectileImpactSound,
  playWeaponFireSound,
} from "../client/FPSCombatAudio";
import { processFPSMovementAudio } from "../client/FPSMovementAudio";
import { playPickupSound } from "../client/FPSPickupAudio";
import {
  isPowerupLabel,
  playPowerupFireSound,
  playPowerupPickupSound,
  playPowerupSpawnSound,
} from "../client/FPSPowerupAudio";
import { HUDState } from "../client/HUDState";
import { clearLocalPowerups, isLocalPowerupActive, setLocalPowerup } from "../client/LocalPowerupState";
import { MatchStateManager } from "../client/MatchStateManager";
import type { RemotePlayerRenderer } from "../client/RemotePlayerRenderer";
import { FPSPlayer } from "../FPSPlayer";
import type { PlayerStateUpdate } from "../Game";
import { FPSPickup } from "../world/FPSPickup";
import type { ServerAmmoState } from "../world/InventoryManager";

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
  /** Teammate being watched while dead, or null. */
  spectatingEntityId: string | null;
  _respawnRequested: boolean;
  _respawnCooldownEnd: number;

  // Lazy effect systems
  _gibSystem: any;
  _pendingGibSpawns: { x: number; y: number; z: number; vx: number; vy: number; vz: number }[];
  _ragdollSystem: any;
  _cartoonHit: any;
  /** Smoothed corpse-follow death camera (driven by FPSController via Game). */
  _deathCamera: import("./DeathCamera").DeathCamera | null;

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
export const WEAPON_EFFECT_COLORS: Record<string, [number, number, number]> = {
  machinegun: [1.0, 0.9, 0.3], // warm yellow
  riotgun: [1.0, 0.6, 0.2], // orange
  voltaic: [1.0, 0.7, 0.1], // warm orange (beam)
  electrobolt: [0.3, 0.6, 1.0], // blue
  instagun: [0.8, 0.2, 1.0], // purple
};

// Reused because VoltaicEffectRenderer copies every field synchronously into
// retained CPU/GPU state. This avoids four Babylon allocations at beam rate.
const voltaicTruthOrigin = new Vector3();
const voltaicTruthDirection = new Vector3();
const voltaicTruthEndpoint = new Vector3();
const voltaicTruthNormal = new Vector3();
const voltaicTruthColor = new Color3(1.0, 0.7, 0.1);
const voltaicTruthConfig: VoltaicBeamTruthConfig = {
  origin: voltaicTruthOrigin,
  direction: voltaicTruthDirection,
  endpoint: voltaicTruthEndpoint,
  impactNormal: voltaicTruthNormal,
  impactKind: "none",
  color: voltaicTruthColor,
  maxRange: 850,
};

// Same scratch-reuse rationale for the one-shot Electrobolt rail: fireRail copies
// every field synchronously into the thin-instance buffers.
const railTruthStart = new Vector3();
const railTruthEnd = new Vector3();
const railTruthNormal = new Vector3();
const railTruthColor = new Color3(0.3, 0.6, 1.0);
const railTruthSample: RailEffectSample = {
  start: railTruthStart,
  end: railTruthEnd,
  impactNormal: railTruthNormal,
  impactKind: "none",
  color: railTruthColor,
};

// Sanity budget for concurrent remote charge glows. Was 2 under the raw-light
// scarcity system; the glows now render through the gameplay cluster (WS1), so
// this is a cosmetic cap, not a shader-safety limit.
const MAX_REMOTE_CHARGE_GLOW_LIGHTS = 6;

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

  // Reconcile server-authoritative pickup visibility every snapshot. This is the
  // convergent source of truth (replaces one-shot item_pickup events + the old
  // client-local respawn timer); a dropped snapshot self-heals on the next one.
  FPSPickup.reconcileActiveSet(state.pickupActiveMask);

  // Process match_state events before anything else
  const localEntityId = state.players.get(ctx.localPlayerId)?.entityId;

  if (state.events && state.events.length > 0) {
    const matchMgr = MatchStateManager.getInstance();

    // Dispatch by event type. Switching on the discriminated `type` (rather than
    // the old if/else-if chain with compound conditions) narrows each `event` so
    // field access is compiler-checked, and the exhaustive `default` catches an
    // unrouted type instead of letting it vanish silently (QA-6).
    for (const event of state.events as SnapshotEvent[]) {
      switch (event.type) {
        case "match_state":
          matchMgr.processEvent(event);
          break;

        case "weapon_state":
          if (event.entityId === localEntityId) {
            handleWeaponStateSync(ctx, event);
          } else if (event.currentWeapon) {
            ctx.enemyWeapons.set(event.entityId, canonicalWeaponId(event.currentWeapon));
          }
          // Deliberately NOT part of the branch above. The local sync drives
          // inventory, reload timing and prediction; a spectated player's state
          // must reach the HUD and the viewmodel WITHOUT touching any of that,
          // or watching someone reload would desync your own weapon.
          if (ctx.spectatingEntityId && event.entityId === ctx.spectatingEntityId) {
            handleSpectatedWeaponState(event);
          }
          break;

        case "weapon_fire": {
          const localShooter = event.entityId === localEntityId;
          playWeaponFireSound(event, localShooter);
          // Quad layers its own crack over your weapon on every shot — the
          // running reminder that this shot hits four times as hard.
          if (localShooter && isLocalPowerupActive("quad")) playPowerupFireSound();
          if (localShooter) {
            const wvm = getWeaponViewManager();
            const isProjectileFire = ctx._localCharging;
            if (ctx._localCharging) ctx._localCharging = false;
            wvm.fire({ isProjectileFire });
          } else {
            handleRemoteWeaponFire(event, ctx.remoteRenderer);
            // Kick the viewmodel when the person we are watching shoots.
            // Without this their gun hangs in frame perfectly still through a
            // whole firefight, which reads as a broken render rather than a
            // spectator view.
            if (ctx.spectatingEntityId === event.entityId) {
              getWeaponViewManager().fire({ isProjectileFire: false });
            }
          }
          break;
        }

        case "voltaic_beam": {
          const localHero = event.entityId === localEntityId;
          const weaponId = localHero ? ctx._lastServerWeapon : ctx.enemyWeapons.get(event.entityId);
          handleVoltaicBeam(event, localHero, weaponId);
          break;
        }

        case "electro_rail": {
          // Authoritative Electrobolt rail truth (endpoint/normal/kind). Drives
          // the procedural rail renderer for both the local shooter and remote
          // players, so the visual endpoint always equals the damage endpoint
          // (no through-wall client-picked rails). The weapon_fire path no longer
          // draws a bolt for bolt weapons, so there is no double-draw.
          const localHero = event.entityId === localEntityId;
          const weaponId = localHero ? ctx._lastServerWeapon : ctx.enemyWeapons.get(event.entityId);
          handleElectroRail(event, localHero, weaponId);
          break;
        }

        case "weapon_charge":
          if (event.entityId === localEntityId) {
            ctx._localCharging = event.charging;
          } else if (event.charging) {
            ctx.chargingPlayers.add(event.entityId);
          } else {
            ctx.chargingPlayers.delete(event.entityId);
            const glow = ctx.chargingGlows.get(event.entityId);
            if (glow) {
              disposeClusteredLight(glow);
              ctx.chargingGlows.delete(event.entityId);
            }
          }
          break;

        case "weapon_chain": {
          // Draw the chain-lightning arcs between the server-provided link points
          // (primary → hop1 → hop2). Shown for all players, including the shooter.
          const fx = getHitscanEffects();
          const pts = event.points.map((p) => new Vector3(p.x, p.y, p.z));
          const rgb = WEAPON_EFFECT_COLORS.voltaic;
          const color = new Color3(rgb[0], rgb[1], rgb[2]);
          for (let i = 0; i < pts.length - 1; i++) {
            fx.fireLightningArc(pts[i], pts[i + 1], color);
          }
          break;
        }

        case "projectile_impact": {
          playProjectileImpactSound(event);
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
          // Projectiles are now identified by projectileId (F8: grenade/plasma_bolt/…);
          // weapon-id forms kept as fallbacks for older demos. rocket (and unknowns)
          // use the rocket explosion.
          const config =
            event.defId === "grenade" || event.defId === "glauncher"
              ? GRENADE_EXPLOSION
              : event.defId === "plasma_bolt" || event.defId === "plasmagun"
                ? PLASMA_EXPLOSION
                : event.defId === "blade_blast"
                  ? BLADE_EXPLOSION
                  : ROCKET_EXPLOSION;
          getExplosionEffect().spawn(pos, config, normal);
          break;
        }

        case "projectile_spawn":
          ctx.serverProjectileDefIds.set(event.entityId, event.defId);
          break;

        case "combat_state":
          // The HUD describes whoever the camera is behind. Resolved once, up
          // front, rather than per-branch: both entities' combat_state arrive in
          // the same snapshot, so a "local, then spectated" ordering assumption
          // would put whichever came last on the bar.
          if (event.entityId === (ctx.spectatingEntityId ?? localEntityId)) {
            HUDState.getInstance().processCombatState(event);
          }
          if (event.entityId === localEntityId) {
            if (event.dead && !ctx._isPlayerDead) {
              ctx._isPlayerDead = true;
              ctx._respawnRequested = false;
              ctx._respawnCooldownEnd = Date.now() + 3000;
              console.log("[GameEvents] Local player died");
              import("../../../engine/weapon/WeaponViewManager").then((m) => {
                const wvm = m.getWeaponViewManager();
                wvm.setVisible(false);
                // Kill the continuous Voltaic beam (including legacy IDs) — death
                // cuts fire input without firing the normal beam-stop edge, so it
                // would otherwise stay stuck on screen through the respawn.
                wvm.setBeamActive(false);
              });
            } else if (!event.dead && ctx._isPlayerDead) {
              ctx._isPlayerDead = false;
              ctx._respawnRequested = false;
              console.log("[GameEvents] Local player respawned");
              ctx._deathCamera?.stop();
              if (ctx.v2Client) {
                ctx.v2Client.resetForRespawn();
              }
              import("../../../engine/weapon/WeaponViewManager").then((m) => {
                m.getWeaponViewManager().setVisible(true);
              });
            }
          } else if (!event.dead && ctx.remoteRenderer) {
            ctx.remoteRenderer.markAlive(event.entityId);
          }
          break;

        case "damage": {
          HUDState.getInstance().processDamage(event);
          playPlayerPainSound(event, event.entityId === localEntityId);

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
            playDamageConfirmationSound(event);
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
          break;
        }

        case "death": {
          const localVictim = event.entityId === localEntityId;
          playPlayerDeathSound(event, localVictim);
          if (event.killerId === localEntityId && !localVictim) playKillEcho();
          // Powerups do not survive death (GametypeController clears them on
          // respawn); drop the local timers now so the HUD and the quad fire
          // layer stop immediately rather than at the next snapshot.
          if (localVictim) clearLocalPowerups();
          handleDeathEvent(ctx, event, state);
          break;
        }

        case "weapon_drop":
          handleWeaponDrop(ctx, event);
          break;

        case "award":
          handleAwardEvent(ctx, event);
          break;

        case "chat":
          handleChatEvent(event);
          break;

        case "pickup_notify":
          if (event.entityId === localEntityId) {
            // Server-authoritative pickup label for the local player (any item type).
            const label = String(event.label ?? "");
            // Powerups have their own, much louder confirmation — routing them
            // through the generic pickup bank would play the weapon "clink".
            if (isPowerupLabel(label)) {
              playPowerupPickupSound();
            } else {
              playPickupSound(label);
            }
            import("./FPSHud")
              .then(({ FPSHud }) => FPSHud.getInstance().pickupToast?.showPickup(label))
              .catch(() => {});
          }
          break;

        case "powerup_state":
          if (event.entityId === localEntityId) {
            setLocalPowerup(String(event.kind ?? ""), Number(event.seconds ?? 0));
          }
          break;

        case "powerup_spawn":
          // Everyone hears the quad return, positioned at the item.
          playPowerupSpawnSound({ x: event.x, y: event.y, z: event.z });
          break;

        case "item_pickup":
          // Pickup visibility is reconciled from state.pickupActiveMask above; the
          // one-shot item_pickup event is intentionally not dispatched here.
          break;

        case "agent_directives":
          // Bot orders. Only ever addressed to one client, and only bots act on
          // them — a human player's client has nothing to do with them. Handled
          // explicitly so the exhaustiveness guard stays meaningful.
          break;

        default:
          // Exhaustive: adding a SnapshotEvent member without a case above is a
          // compile error here; an unknown runtime type warns instead of vanishing.
          assertUnroutedEvent(event);
          break;
      }
    }
  }

  processFPSMovementAudio(state, localEntityId);

  // === Update charge glow positions from entity data ===
  // Charge glows render through the gameplay light cluster (WS1), so many
  // concurrent glows cost one material-visible light; the slot cap below is now
  // just a sanity budget, not a shader-variant safety limit.
  for (const [entityId, glow] of ctx.chargingGlows) {
    if (!ctx.chargingPlayers.has(entityId) || !state.entities.has(entityId)) {
      disposeClusteredLight(glow);
      ctx.chargingGlows.delete(entityId);
    }
  }

  if (ctx.chargingPlayers.size > 0) {
    const scene = CameraSystem.getInstance().getCamera()?.getScene();
    if (scene) {
      let glowSlots = 0;
      for (const entityId of ctx.chargingPlayers) {
        const entity = state.entities.get(entityId);
        const pos = entity?.getComponent("position") as { x: number; y: number; z: number } | undefined;
        if (!pos) continue;

        if (glowSlots >= MAX_REMOTE_CHARGE_GLOW_LIGHTS) {
          const overflowGlow = ctx.chargingGlows.get(entityId);
          if (overflowGlow) {
            disposeClusteredLight(overflowGlow);
            ctx.chargingGlows.delete(entityId);
          }
          continue;
        }
        glowSlots++;

        let light = ctx.chargingGlows.get(entityId);
        if (!light) {
          light = new PointLight(`charge_glow_${entityId}`, new Vector3(pos.x, pos.y + 30, pos.z), scene);
          light.diffuse = new Color3(1.0, 0.15, 0.05);
          light.specular = new Color3(1.0, 0.1, 0.0);
          light.range = 60;
          light.intensity = 8;
          addToDynamicLightCluster(scene, light);
          ctx.chargingGlows.set(entityId, light);
        }
        light.position.set(pos.x, pos.y + 30, pos.z);
      }
    }
  }

  // Update HUD state aggregator
  const hudState = HUDState.getInstance();
  hudState.localPlayerId = ctx.localPlayerId;
  hudState.spectating = ctx.spectatingEntityId ?? "";
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
  {
    let projectileSLT: number | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: gameHost clockSync is duck-typed
    const projNh = ctx.gameHost as any;
    if (state.serverTimestamp && projNh?.clockSync?.isSynced()) {
      projectileSLT = projNh.clockSync.toLocalTime(state.serverTimestamp);
    }
    processProjectileEntities(
      state,
      { active: ctx.activeServerProjectiles, defIds: ctx.serverProjectileDefIds, buffer: ctx.projectileBuffer },
      projectileSLT,
    );
  }

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

function handleDeathEvent(ctx: GameEventContext, event: any, state: GameState): void {
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

  // Local player death: the local player has no normal third-person model, so
  // create one for ragdoll deaths and bind the camera to the live ragdoll handle.
  // Gib deaths bind to the live gib burst centroid when the gib system is ready.
  const localEntityId = state.players.get(ctx.localPlayerId)?.entityId;
  const isLocalDeath = event.entityId === localEntityId;
  if (
    !shouldGib &&
    isLocalDeath &&
    event.x !== undefined &&
    ctx.remoteRenderer &&
    ctx._ragdollSystem &&
    ctx._deathCamera
  ) {
    startLocalRagdollDeathCamera(ctx, event);
  }

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
      let gibHandle: { getPosition(): Vector3 | null } | null = null;
      if (ctx._gibSystem) {
        gibHandle = ctx._gibSystem.spawn(event.x, event.y, event.z, event.velX || 0, event.velY || 0, event.velZ || 0);
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
      if (isLocalDeath && gibHandle && ctx._deathCamera) {
        const camYaw = getCurrentCameraYaw();
        const deathPos = new Vector3(event.x, event.y, event.z);
        ctx._deathCamera.start(() => gibHandle?.getPosition() ?? null, deathPos, camYaw);
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

function startLocalRagdollDeathCamera(ctx: GameEventContext, event: any): void {
  const renderer = ctx.remoteRenderer;
  const ragdolls = ctx._ragdollSystem;
  const deathCamera = ctx._deathCamera;
  if (!renderer || !ragdolls || !deathCamera || event.x === undefined) return;

  const camYaw = getCurrentCameraYaw();
  const deathPos = new Vector3(event.x, event.y, event.z);
  const createModel = renderer.createDetachedModelAtAsync
    ? renderer.createDetachedModelAtAsync(event.entityId, event.x, event.y, event.z, camYaw)
    : Promise.resolve(renderer.createDetachedModelAt(event.entityId, event.x, event.y, event.z, camYaw));

  createModel
    .then((model: any) => {
      if (!model) return;
      if (!ctx._isPlayerDead) {
        disposeDetachedModel(model);
        return;
      }
      const handle = ragdolls.spawn(model, event.kbDirX || 0, event.kbDirY || 0, event.kbDirZ || 0);
      if (handle && ctx._isPlayerDead) {
        deathCamera.start(() => handle.getPosition(), deathPos, camYaw);
      }
    })
    .catch((e: unknown) => {
      console.error("[Death] Local corpse-cam setup error:", e);
    });
}

function getCurrentCameraYaw(): number {
  const cam = CameraSystem.getInstance().getCamera() as { rotation?: { y?: number } } | null;
  return cam?.rotation?.y ?? 0;
}

function disposeDetachedModel(model: any): void {
  try {
    model.attachedWeapon?.dispose?.(false, true);
    model.masterGroup?.stop?.();
    model.masterGroup?.dispose?.();
    model.mesh?.dispose?.();
    model.skeleton?.dispose?.();
    model.anchor?.dispose?.();
  } catch {
    /* model cleanup is best-effort after an async death-camera race */
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

  const serverWeapon = canonicalWeaponId(event.currentWeapon as string);
  const serverWeapons = [...new Set((event.weapons as string[]).map(canonicalWeaponId))];
  const rawAmmo = event.ammo as Record<string, ServerAmmoState>;
  const serverAmmo = Object.fromEntries(
    Object.entries(rawAmmo).map(([weaponId, ammo]) => [canonicalWeaponId(weaponId), ammo]),
  ) as Record<string, ServerAmmoState>;

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

  // Reconcile the first-person viewmodel against the authoritative server weapon.
  //
  // This is deliberately LEVEL-triggered against the weapon the viewmodel is
  // actually displaying — not edge-triggered on _lastServerWeapon. A client-
  // predicted switch (scroll/number key) that never lands server-side leaves the
  // server weapon unchanged, so an edge-triggered check would never fire and the
  // viewmodel stayed stuck on the mispredicted weapon (fired RL while showing PG).
  // Comparing to the displayed weapon self-heals that: once the predicted switch
  // animation settles, any disagreement with the server is corrected.
  const wvm = getWeaponViewManager();
  if (wvm.isReady) {
    const hadServerWeapon = ctx._lastServerWeapon !== undefined;
    const displayed = wvm.getDisplayedWeaponId();
    ctx._lastServerWeapon = serverWeapon;

    if (!hadServerWeapon || displayed === null) {
      // Initial equip — load instantly (no slide animation on spawn).
      wvm.loadWeapon(serverWeapon).catch((err) => {
        console.error(`[GameEvents] Failed to load initial weapon: ${serverWeapon}`, err);
      });
    } else if (displayed !== serverWeapon && !wvm.isSwitching()) {
      // Viewmodel settled on a weapon the server disagrees with (mispredicted or
      // dropped switch input) — animate to the authoritative weapon. The
      // !isSwitching guard leaves an in-flight predicted switch alone so normal
      // switching stays responsive.
      console.log(`[GameEvents] Reconciling viewmodel ${displayed} → server ${serverWeapon}`);
      wvm.switchWeaponAnimated(serverWeapon).catch((err) => {
        console.error(`[GameEvents] Failed to switch weapon: ${serverWeapon}`, err);
      });
    }
  }
}

/**
 * Put a spectated player's weapon on the HUD and in our hands.
 *
 * Everything needed is already on the wire — the server broadcasts weapon_state
 * for every player so the kill feed and third-person models work — so watching
 * someone properly is a routing job, not a protocol change.
 *
 * Strictly display. None of the local sync's inventory writes, reload timing or
 * speed-bonus prediction happens here: those describe the weapon WE are holding
 * and the server would fight us over every one of them.
 */
export function handleSpectatedWeaponState(event: {
  currentWeapon: string;
  weapons: string[];
  ammo: Record<string, ServerAmmoState>;
}): void {
  const weapon = canonicalWeaponId(event.currentWeapon);
  const weapons = [...new Set((event.weapons ?? []).map(canonicalWeaponId))];
  const ammo = Object.fromEntries(
    Object.entries(event.ammo ?? {}).map(([id, value]) => [canonicalWeaponId(id), value]),
  ) as Record<string, ServerAmmoState>;

  HUDState.getInstance().processWeaponState({ currentWeapon: weapon, weapons, ammo });

  // The viewmodel rides the same camera the spectate camera drives, so showing
  // their gun is a matter of loading it and unhiding. Level-triggered against
  // what is actually displayed, exactly like the local reconciliation: it then
  // self-heals when the target switches, when we cycle to someone holding
  // something else, and when we respawn back onto our own weapon.
  const wvm = getWeaponViewManager();
  if (!wvm.isReady) return;
  const displayed = wvm.getDisplayedWeaponId();
  if (displayed !== weapon && !wvm.isSwitching()) {
    wvm.loadWeapon(weapon).catch(() => {
      // A weapon we cannot load leaves the previous model up. Not worth
      // interrupting a spectator over.
    });
  }
  wvm.setVisible(true);
}

/**
 * Spawn visual effects for another player's weapon fire.
 */
export function handleRemoteWeaponFire(event: any, remoteRenderer: RemotePlayerRenderer | null): void {
  const fx = getHitscanEffects();
  const projMgr = getProjectileManager();

  if (!projMgr["scene"]) {
    const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
    if (gameScene) projMgr.init(gameScene);
  }

  const origin = new Vector3(event.originX, event.originY, event.originZ);
  const dir = new Vector3(event.dirX, event.dirY, event.dirZ);
  const weaponId = canonicalWeaponId(event.weaponId);
  const rgb = WEAPON_EFFECT_COLORS[weaponId];
  const color = rgb ? new Color3(rgb[0], rgb[1], rgb[2]) : new Color3(1, 1, 0.5);

  switch (weaponId) {
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
      // Legacy-demo / packet fallback. Live snapshots overwrite this immediately
      // with exact player/world contact from the following voltaic_beam event.
      fx.updateRemoteLightningFallback(event.entityId, {
        origin,
        traceOrigin: origin,
        direction: dir,
        color,
        maxRange: 850,
      });
      break;
    case "electrobolt":
    case "instagun":
      // Rail is drawn from the authoritative electro_rail event (WO-EB3), not
      // from this predicted client-side trace — avoids a through-wall bolt and a
      // double draw. The muzzle flash still comes from the weapon_fire anim.
      break;
    case "plasmagun":
    case "rlauncher":
    case "glauncher":
      break;
    case "blade":
      remoteRenderer?.playAttackAnim(event.entityId, "blade_slash", 2.0);
      break;
    default:
      fx.fireTracer({ origin, direction: dir, color, maxRange: 5000 });
      break;
  }
}

/** Apply exact server beam truth while keeping all electrical detail client-side. */
export function handleVoltaicBeam(event: VoltaicBeamEvent, localHero: boolean, weaponId = "voltaic"): void {
  const fx = getHitscanEffects();
  voltaicTruthOrigin.set(event.originX, event.originY, event.originZ);
  voltaicTruthDirection.set(event.dirX, event.dirY, event.dirZ);
  voltaicTruthEndpoint.set(event.endX, event.endY, event.endZ);
  voltaicTruthNormal.set(event.normalX, event.normalY, event.normalZ);
  const rgb = WEAPON_EFFECT_COLORS[canonicalWeaponId(weaponId)] ?? WEAPON_EFFECT_COLORS.voltaic;
  voltaicTruthColor.set(rgb[0], rgb[1], rgb[2]);
  voltaicTruthConfig.impactKind = event.impactKind === 2 ? "player" : event.impactKind === 1 ? "world" : "none";

  if (localHero) fx.updateLocalLightningTruth(voltaicTruthConfig);
  else fx.updateRemoteLightningBeam(event.entityId, voltaicTruthConfig);
}

/** Spawn a one-shot Electrobolt rail from the authoritative server truth. */
export function handleElectroRail(event: ElectroRailEvent, localHero: boolean, weaponId = "electrobolt"): void {
  const fx = getHitscanEffects();
  // Anchor the visible start to the actual gun muzzle for the local shooter. The
  // server origin is the eye (camera); a beam vertex exactly at the camera
  // projects degenerately (w≈0), smearing the near end to a screen corner and
  // making it emanate from the wrong side of the gun. The damage endpoint is
  // untouched — only the drawn start moves to the barrel (as the Voltaic beam does).
  const muzzle = localHero ? getWeaponViewManager().getMuzzleWorldPosition() : null;
  if (muzzle) railTruthStart.copyFrom(muzzle);
  else railTruthStart.set(event.originX, event.originY, event.originZ);
  railTruthEnd.set(event.endX, event.endY, event.endZ);
  railTruthNormal.set(event.normalX, event.normalY, event.normalZ);
  const rgb = WEAPON_EFFECT_COLORS[canonicalWeaponId(weaponId)] ?? WEAPON_EFFECT_COLORS.electrobolt;
  railTruthColor.set(rgb[0], rgb[1], rgb[2]);
  railTruthSample.impactKind = event.impactKind === 2 ? "player" : event.impactKind === 1 ? "world" : "none";
  fx.fireRail(railTruthSample);
}

/**
 * Process server-driven projectile entities (Q3-style spawn/despawn/interpolation).
 */
/** Mutable projectile-sync collections, shared by live play and demo playback. */
export interface ProjectileSyncState {
  /** Server entity ids we've spawned a visual for */
  active: Set<string>;
  /** proj_ entityId → defId (from projectile_spawn events) */
  defIds: Map<string, string>;
  /** Interpolation buffer for smooth in-flight motion */
  buffer: SnapshotBuffer;
}

export function processProjectileEntities(state: GameState, sync: ProjectileSyncState, serverLocalTime?: number): void {
  const projEntities = new Map<string, EntitySnapshot>();
  const aliveThisSnapshot = new Set<string>();

  for (const [entityId, entity] of state.entities) {
    if (!entityId.startsWith("proj_")) continue;
    aliveThisSnapshot.add(entityId);

    // biome-ignore lint/suspicious/noExplicitAny: duck-typed snapshot components
    const posComp = entity.getComponent("position") as any;
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed snapshot components
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
      wallJumping: false,
    });

    if (!sync.active.has(entityId)) {
      const defId = sync.defIds.get(entityId);
      if (defId) {
        const projMgr = getProjectileManager();
        if (!projMgr["scene"]) {
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) projMgr.init(gameScene);
        }
        const pos = new Vector3(posComp.x, posComp.y, posComp.z);
        const vel = velComp ? new Vector3(velComp.x, velComp.y, velComp.z) : Vector3.Zero();
        projMgr.spawnFromServer(entityId, defId, pos, vel);
        sync.active.add(entityId);
      }
    }
  }

  // Push to interpolation buffer
  sync.buffer.push(state.tick, projEntities, serverLocalTime);

  // Despawn visuals for projectiles that disappeared
  for (const entityId of sync.active) {
    if (!aliveThisSnapshot.has(entityId)) {
      getProjectileManager().despawnByEntityId(entityId);
      sync.active.delete(entityId);
      sync.defIds.delete(entityId);
    }
  }
}

// ── Award Event Handler ────────────────────────────────────────────

/** In-game chat event → HUD chat log (also fires during demo playback). */
// biome-ignore lint/suspicious/noExplicitAny: duck-typed snapshot event
function handleChatEvent(event: any): void {
  try {
    console.log(`[Chat] event ← server: ${event.senderName}: "${event.text}"`);
    const name = event.senderName || "unknown";
    const prefix = event.team === "spectator" ? "[SPEC] " : "";
    import("./FPSHud")
      .then(({ FPSHud }) => {
        FPSHud.getInstance().chat?.addMessage(prefix + name, String(event.text ?? ""), event.team ?? "");
      })
      .catch(() => {});
  } catch (e) {
    console.error("[Chat] event error:", e);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: duck-typed snapshot event
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
    playerId === toClientKey(ctx.localPlayerId) ||
    toClientKey(playerId) === ctx.localPlayerId;

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
