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
import { disposePlayerModel } from "../../../engine/animation/PlayerModelManager";
import { CameraSystem } from "../../../engine/camera";
import { log } from "../../../engine/core/Log";
import { addToDynamicLightCluster, disposeClusteredLight } from "../../../engine/lighting/DynamicLightCluster";
import { NetGraph } from "../../../engine/network/client/NetGraph";
import type { EntitySnapshot, SnapshotBuffer } from "../../../engine/network/client/SnapshotBuffer";
import type { TransformComponent } from "../../../engine/network/components/TransformComponent";
import type { VelocityComponent } from "../../../engine/network/components/VelocityComponent";
import type { GameState } from "../../../engine/network/core/GameState";
import type { IGameHost } from "../../../engine/network/core/IGameHost";
import {
  type AwardSnapshotEvent,
  assertUnroutedEvent,
  type ChatSnapshotEvent,
  type DamageEvent,
  type DeathEvent,
  type ElectroRailEvent,
  type SnapshotEvent,
  type VoltaicBeamEvent,
  type WeaponDropEvent,
  type WeaponFireEvent,
  type WeaponStateEvent,
} from "../../../engine/network/core/SnapshotEvent";
import {
  BLADE_EXPLOSION,
  GRENADE_EXPLOSION,
  getExplosionEffect,
  PLASMA_EXPLOSION,
  ROCKET_EXPLOSION,
} from "../../../engine/weapon/ExplosionEffect";
import {
  getHitscanEffects,
  serverPelletDirections,
  type VoltaicBeamTruthConfig,
} from "../../../engine/weapon/HitscanEffects";
import { getProjectileManager } from "../../../engine/weapon/ProjectileManager";
import type { RailEffectSample } from "../../../engine/weapon/rail/RailProfiles";
import { getWeaponViewManager, type LocalShot } from "../../../engine/weapon/WeaponViewManager";
import { canonicalWeaponId, WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import { DEFAULT_PHYSICS_TICK_RATE } from "../../../shared/server/simulation/physics/constants";
import { toClientKey } from "../ClientEntityKey";
import type { ServerSnapshot, V2NetworkClient } from "../client";
import { Crosshair } from "../client/Crosshair";
import { DamageNumbers } from "../client/DamageNumbers";
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
import type { HitLocationName } from "../client/HitLocationName";
import { HUDState } from "../client/HUDState";
import {
  clearLocalPowerups,
  isLocalPowerupActive,
  keepOnlyLocalPowerups,
  setLocalPowerup,
} from "../client/LocalPowerupState";
import type { RemotePlayerRenderer } from "../client/RemotePlayerRenderer";
import { FPSPlayer } from "../FPSPlayer";
import type { PlayerStateUpdate } from "../Game";
import { FPSPickup } from "../world/FPSPickup";
import type { ServerAmmoState } from "../world/InventoryManager";
import { devLog } from "./DevLog";
import type { FollowedViewWeapon } from "./FollowedViewWeapon";
import { playerVoiceForEntity } from "./FPSPlayerAudio";
import type { FPSReloadAudio } from "./FPSReloadAudio";
import { networkHostOf } from "./NetworkHostAccess";

/**
 * Mutable context shared with Game.
 * Fields are references (Maps, Sets, arrays) — mutations are visible to both sides.
 */
export interface GameEventContext {
  // Identity
  localPlayerId: string;
  isNetworkMode: boolean;
  gameHost: IGameHost | null;

  /**
   * A recorded demo rather than a live connection. Demo playback feeds its own
   * recorded-tick timeline to the renderer, and has no clock to sync.
   */
  playback?: "demo";
  /**
   * False on a frame whose one-off effects must not play — a demo seek's
   * landing frame. State still applies; sounds, effects and messages do not.
   */
  presentOneShots?: boolean;
  reloadAudio?: FPSReloadAudio;
  /** Hit numbers on a clock of their own (a demo's); the shared ones otherwise. */
  damageNumbers?: { spawn(x: number, y: number, z: number, damage: number, hitLocation?: HitLocationName): void };

  // V2 Client (prediction/reconciliation)
  v2Client: V2NetworkClient | null;

  /** Re-baseline the local body's water level after a respawn or teleport. */
  forgetLocalLiquid?: () => void;

  /** Refill the local air mirror, so a drowned player does not respawn gasping. */
  resetLocalAir?: () => void;

  /** Drop a despawned projectile's liquid-crossing tracking. */
  forgetProjectileLiquid?: (entityId: string) => void;

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
  projectileSeenTicks: Map<string, number>;
  projectileBuffer: SnapshotBuffer;

  // Death state
  _isPlayerDead: boolean;
  /**
   * Whose eyes the view is behind — the teammate watched while dead, or the
   * player a spectator is chasing — or null when it is our own.
   */
  spectatingEntityId: string | null;
  /** True while we are a spectator rather than a player. */
  readonly isWatcher: boolean;
  /** The watched player's weapon in front of the camera. */
  followedWeapon: FollowedViewWeapon;
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
/**
 * Events that are a moment rather than a state: a shot, a hit, a death, a
 * message. A demo seek lands without them; everything else still applies.
 */
const ONE_SHOT_EVENTS: ReadonlySet<string> = new Set([
  "weapon_fire",
  "voltaic_beam",
  "electro_rail",
  "weapon_chain",
  "projectile_impact",
  "damage",
  "death",
  "weapon_drop",
  "award",
  "chat",
  "pickup_notify",
  "powerup_spawn",
  "item_pickup",
]);

export function handleServerStateUpdate(ctx: GameEventContext, state: GameState): void {
  ctx._stateUpdateCount++;
  ctx.reloadAudio?.prune(state.entities.keys());

  // Record snapshot for NetGraph
  const localPlayer = state.players.get(ctx.localPlayerId);
  if (ctx.playback !== "demo") NetGraph.recordSnapshot(localPlayer?.ping ?? 0, state.tick);

  // Feed ClockSync offset to NetGraph for display
  const networkHost = networkHostOf(ctx.gameHost);
  if (networkHost?.clockSync.isSynced()) {
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
  // Whose eyes the view is behind. What that player hears and sees first
  // person — their gun, their footsteps, their pain, their pickups — is what
  // the screen shows. What changes our own state stays on localEntityId.
  const viewEntityId = ctx.spectatingEntityId ?? localEntityId;
  let viewPlayerId: string | undefined;
  for (const [playerId, player] of state.players) {
    if (player.entityId === viewEntityId) viewPlayerId = playerId;
  }
  /** Powerups this snapshot says the viewed player holds; any other has ended. */
  const runningPowerups = new Set<string>();

  if (state.events && state.events.length > 0) {
    // Dispatch by event type. Switching on the discriminated `type` (rather than
    // the old if/else-if chain with compound conditions) narrows each `event` so
    // field access is compiler-checked, and the exhaustive `default` catches an
    // unrouted type instead of letting it vanish silently (QA-6).
    //
    // Each event runs on its own: one that throws is logged and the rest of the
    // snapshot still runs, so a failing effect cannot take the kill feed, the
    // damage numbers or our own weapon sync with it.
    for (const event of state.events as SnapshotEvent[]) {
      if (ctx.presentOneShots === false && ONE_SHOT_EVENTS.has(event.type)) continue;
      try {
        switch (event.type) {
          case "match_state":
            // Stored before anything else ran (storeSnapshotState), with every
            // player's weapon_state and enemyWeapons.
            break;

          case "weapon_state":
            ctx.reloadAudio?.observe(
              event,
              event.entityId === viewEntityId,
              state.entities.get(event.entityId)?.getComponent<TransformComponent>("transform")?.position,
              ctx.presentOneShots !== false,
            );
            if (event.entityId === localEntityId) {
              handleWeaponStateSync(ctx, event);
            }
            // Deliberately NOT part of the branch above. The local sync drives
            // inventory, reload timing and prediction; a spectated player's state
            // must reach the HUD and the viewmodel WITHOUT touching any of that,
            // or watching someone reload would desync your own weapon.
            if (ctx.spectatingEntityId && event.entityId === ctx.spectatingEntityId) {
              // A seek lands with the weapon already in hand
              handleSpectatedWeaponState(event, ctx.followedWeapon, ctx.presentOneShots === false);
            }
            break;

          case "weapon_fire": {
            const localShooter = event.entityId === localEntityId;
            playWeaponFireSound(event, event.entityId === viewEntityId);
            // Quad layers its own crack over your weapon on every shot — the
            // running reminder that this shot hits four times as hard.
            if (localShooter && isLocalPowerupActive("quad")) playPowerupFireSound();
            if (localShooter) {
              const wvm = getWeaponViewManager();
              const isProjectileFire = ctx._localCharging;
              if (ctx._localCharging) ctx._localCharging = false;
              wvm.fire({ isProjectileFire, shot: shotOf(event) });
              kickLocalView(event.weaponId, wvm.getAdsProgress());
              Crosshair.getInstance().notifyFired(WEAPONS[canonicalWeaponId(event.weaponId)]);
            } else {
              handleRemoteWeaponFire(event, ctx.remoteRenderer);
              // Flash and kick the viewmodel when the person we are watching
              // shoots. Only the presentation: their tracer is the one
              // handleRemoteWeaponFire just drew.
              if (ctx.spectatingEntityId === event.entityId) ctx.followedWeapon.fired();
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
            // Watched through their eyes, their rail leaves the gun on screen
            const followedMuzzle = ctx.spectatingEntityId === event.entityId ? ctx.followedWeapon.beamMuzzle() : null;
            handleElectroRail(event, localHero, weaponId, followedMuzzle);
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
            if (event.entityId === viewEntityId) {
              HUDState.getInstance().processCombatState(event);
            }
            if (ctx.spectatingEntityId && event.entityId === ctx.spectatingEntityId) {
              ctx.followedWeapon.setDead(event.dead ?? false);
            }
            if (event.entityId === localEntityId) {
              // Always ours, whoever the camera is following.
              HUDState.getInstance().localDead = event.dead ?? false;
              if (event.dead && !ctx._isPlayerDead) {
                ctx._isPlayerDead = true;
                ctx._respawnRequested = false;
                ctx._respawnCooldownEnd = Date.now() + 3000;
                devLog("[GameEvents] Local player died");
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
                devLog("[GameEvents] Local player respawned");
                ctx._deathCamera?.stop();
                if (ctx.v2Client) {
                  ctx.v2Client.resetForRespawn();
                }
                // A respawn moves the body without swimming it anywhere. Dying at
                // the bottom of a pool and coming back dry is a water level going
                // 3 to 0 with no surface broken, which would splash at the spawn
                // point; forgetting makes the next report a baseline instead.
                ctx.forgetLocalLiquid?.();
                // And you come back with full lungs, not the ones you drowned on.
                ctx.resetLocalAir?.();
                import("../../../engine/weapon/WeaponViewManager").then((m) => {
                  m.getWeaponViewManager().setVisible(true);
                });
              }
            } else if (!event.dead && ctx.remoteRenderer) {
              ctx.remoteRenderer.markAlive(event.entityId);
            } else if (ctx.presentOneShots === false && ctx.remoteRenderer) {
              // A seek lands past the death without its event; the death
              // event detaches the model for the ragdoll, so only then
              ctx.remoteRenderer.markDead(event.entityId);
            }
            break;

          case "damage": {
            HUDState.getInstance().processDamage(event);
            playPlayerPainSound(
              event,
              event.entityId === viewEntityId,
              undefined,
              playerVoiceForEntity(state, event.entityId, viewEntityId),
            );

            // === INCOMING DAMAGE: the player on screen is the victim ===
            if (event.entityId === viewEntityId && event.damage > 0) {
              // Compute direction angle from attacker to victim
              let damageAngle = Math.random() * Math.PI * 2; // fallback: random

              if (event.attackerId && event.attackerId !== viewEntityId) {
                // Get attacker position from state entities
                const attackerEntity = state.entities.get(event.attackerId);
                const attackerPos = attackerEntity?.getComponent("position") as
                  | { x: number; y: number; z: number }
                  | undefined;
                const victimEntity = state.entities.get(viewEntityId || "");
                const victimPos = victimEntity?.getComponent("position") as
                  | { x: number; y: number; z: number }
                  | undefined;

                if (attackerPos && victimPos) {
                  // World-space direction from attacker to victim
                  const worldDx = attackerPos.x - victimPos.x;
                  const worldDz = attackerPos.z - victimPos.z;
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

              // Pain camera shake (all weapon types). Only our own: it lives in
              // the FPS controller, which a spectate camera does not run.
              const fpsCtrl = CameraSystem.getInstance().getController("fps");
              if (event.entityId === localEntityId && fpsCtrl && "shakeCamera" in fpsCtrl) {
                const painIntensity = Math.min(Math.max(event.damage / 100, 0.05), 0.6);
                (fpsCtrl as any).shakeCamera(painIntensity);
              }
            }

            // === OUTGOING DAMAGE: the player on screen is the attacker ===
            if (event.attackerId && event.attackerId === viewEntityId) {
              handleOutgoingDamage(ctx, event);
            }
            break;
          }

          case "death": {
            const viewVictim = event.entityId === viewEntityId;
            playPlayerDeathSound(event, viewVictim, playerVoiceForEntity(state, event.entityId, viewEntityId));
            if (event.killerId === viewEntityId && !viewVictim) playKillEcho();
            // Powerups do not survive death (GametypeController clears them on
            // respawn); drop the timers now so the HUD and the quad fire layer
            // stop immediately rather than at the next snapshot.
            if (viewVictim) clearLocalPowerups();
            if (ctx.spectatingEntityId && event.entityId === ctx.spectatingEntityId) ctx.followedWeapon.setDead(true);
            handleDeathEvent(ctx, event, state);
            break;
          }

          case "weapon_drop":
            handleWeaponDrop(ctx, event);
            break;

          case "award":
            handleAwardEvent(ctx, event, viewPlayerId);
            break;

          case "chat":
            handleChatEvent(event);
            break;

          case "pickup_notify":
            if (event.entityId === viewEntityId) {
              // Server-authoritative pickup label for the player on screen (any item type).
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
            if (event.entityId === viewEntityId) {
              setLocalPowerup(String(event.kind ?? ""), Number(event.seconds ?? 0));
              if (Number(event.seconds ?? 0) > 0) runningPowerups.add(String(event.kind ?? ""));
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

          case "knockback_state":
            // Restored with the matching authoritative position below, not as a
            // one-shot impulse (which would apply snapshot velocity twice).
            break;

          default:
            // Exhaustive: adding a SnapshotEvent member without a case above is a
            // compile error here; an unknown runtime type warns instead of vanishing.
            assertUnroutedEvent(event);
            break;
        }
      } catch (err) {
        log.errorRateLimited("GameEvents", `${event.type} event failed:`, err);
      }
    }
  }
  // A Quad taken away early (a round start respawns its carrier alive) stops
  // showing and sounding now, not when its old countdown would have run out.
  keepOnlyLocalPowerups(runningPowerups);

  if (ctx.presentOneShots !== false) processFPSMovementAudio(state, viewEntityId);

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
          light.diffuse = new Color3(0.05, 1.0, 0.9);
          light.specular = new Color3(0.05, 1.0, 0.9);
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
  hudState.watcher = ctx.isWatcher;
  hudState.playback = ctx.playback === "demo";
  hudState.updateScoreboard(state);
  hudState.expireTransients();
  hudState.updateDebugOverlay();

  // === Remote player snapshot buffering ===
  // A demo feeds the renderer its own recorded-tick timeline instead.
  if (ctx.remoteRenderer && ctx.playback !== "demo") {
    let serverLocalTime: number | undefined;
    const nh = networkHostOf(ctx.gameHost);
    if (state.serverTimestamp && nh?.clockSync.isSynced()) {
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
    const projNh = networkHostOf(ctx.gameHost);
    if (state.serverTimestamp && projNh?.clockSync.isSynced()) {
      projectileSLT = projNh.clockSync.toLocalTime(state.serverTimestamp);
    }
    processProjectileEntities(
      state,
      {
        active: ctx.activeServerProjectiles,
        defIds: ctx.serverProjectileDefIds,
        seenTicks: ctx.projectileSeenTicks,
        buffer: ctx.projectileBuffer,
        forgetLiquid: ctx.forgetProjectileLiquid,
        muzzleForShot: ctx.spectatingEntityId
          ? (position, velocity) => ctx.followedWeapon.muzzleFor(position, velocity)
          : ctx._isPlayerDead
            ? undefined
            : (position, velocity) => getWeaponViewManager().getProjectileMuzzlePosition(position, velocity),
      },
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
      lifts: state.events.find((event) => event.type === "lift_state")?.lifts,
      position: { ...transform.position },
      velocity: { ...velocity.linear },
      grounded: velocity.grounded,
      knockbackAgeTicks:
        state.events.find((event) => event.type === "knockback_state" && event.entityId === player.entityId)
          ?.ageTicks ?? null,
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

function handleDeathEvent(ctx: GameEventContext, event: DeathEvent, state: GameState): void {
  devLog(
    `[Death] Event received: entity=${event.entityId} killer=${event.killerId} damageType=${event.damageType} finalDamage=${event.finalDamage} pos=(${event.x}, ${event.y}, ${event.z})`,
  );
  // Names are resolved here, where the players are known: the event carries
  // entity ids, and the HUD shows people
  const victimName = resolvePlayerName(event.entityId, state) || "unknown";
  const killerName = event.killerId ? resolvePlayerName(event.killerId, state) : "";
  const localEntityId = state.players.get(ctx.localPlayerId)?.entityId;
  try {
    HUDState.getInstance().processDeath(event, { killerName, victimName, localEntityId });
  } catch (e) {
    console.error("[Death] HUD processDeath error:", e);
  }

  // Push kill message to EventFeed
  try {
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
  // The bomb always gibs: its blasts are the round-end show, and a ragdoll would
  // only fall over in the middle of it.
  const shouldGib = damageType === "rail" || damageType === "bomb" || (damageType === "explosion" && finalDamage >= 50);

  // Local player death: the local player has no normal third-person model, so
  // create one for ragdoll deaths and bind the camera to the live ragdoll handle.
  // Gib deaths bind to the live gib burst centroid when the gib system is ready.
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
      devLog(`[GibSystem] Gib death: dmgType=${damageType} dmg=${finalDamage}`);
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
    devLog(`[RagdollSystem] Ragdoll death: dmgType=${damageType} dmg=${finalDamage}`);
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
      disposePlayerModel(model);
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

function startLocalRagdollDeathCamera(ctx: GameEventContext, event: DeathEvent): void {
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

function handleWeaponDrop(ctx: GameEventContext, event: WeaponDropEvent): void {
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
export function handleWeaponStateSync(ctx: GameEventContext, event: WeaponStateEvent): void {
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

  // While we watch someone else, the HUD and the gun in hand are theirs
  // (handleSpectatedWeaponState). Our own state arrives every snapshot and
  // theirs only when it changes, so ours must stop here or it paints over
  // theirs for good. Nothing is lost: the reconcile below compares against the
  // gun on screen, so the first snapshot after the spectate ends puts ours back.
  if (ctx.spectatingEntityId && ctx.spectatingEntityId !== event.entityId) {
    ctx._lastServerWeapon = serverWeapon;
    return;
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
      devLog(`[GameEvents] Reconciling viewmodel ${displayed} → server ${serverWeapon}`);
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
export function handleSpectatedWeaponState(
  event: {
    currentWeapon: string;
    weapons: string[];
    ammo: Record<string, ServerAmmoState>;
  },
  followed: FollowedViewWeapon,
  instant = false,
): void {
  const weapon = canonicalWeaponId(event.currentWeapon);
  const weapons = [...new Set((event.weapons ?? []).map(canonicalWeaponId))];
  const ammo = Object.fromEntries(
    Object.entries(event.ammo ?? {}).map(([id, value]) => [canonicalWeaponId(id), value]),
  ) as Record<string, ServerAmmoState>;

  HUDState.getInstance().processWeaponState({ currentWeapon: weapon, weapons, ammo });

  // The viewmodel rides the same camera the spectate camera drives. Their
  // switches play as switches; the first weapon after a target change is
  // already in hand. Our own weapon comes back through the local
  // reconciliation when we respawn.
  followed.showWeapon(weapon, instant);
}

/** Our own shot as the server fired it: its ray, spread included, and any pellet seed. */
function shotOf(event: WeaponFireEvent): LocalShot {
  return {
    origin: new Vector3(event.originX, event.originY, event.originZ),
    direction: new Vector3(event.dirX, event.dirY, event.dirZ),
    pelletSeed: event.pelletSeed,
    pelletSpread: event.pelletSpread,
  };
}

/** The camera side of the view kick (`FPSController.kickView`). */
interface ViewKickTarget {
  kickView(pitchDegrees: number, yawDegrees: number, recoverSeconds: number): void;
}

/**
 * Our own shot kicks the view (`WeaponDef.viewKick`), blended from hip to aimed
 * by how far we are into ADS, with a random sideways part. Visual only: the
 * controller keeps it out of the aim it sends.
 */
function kickLocalView(weaponId: string, adsProgress: number): void {
  const kick = WEAPONS[canonicalWeaponId(weaponId)]?.viewKick;
  if (!kick) return;
  const controller = CameraSystem.getInstance().getController("fps") as Partial<ViewKickTarget> | undefined;
  if (!controller?.kickView) return;
  const ads = Math.max(0, Math.min(1, adsProgress));
  const pitch = kick.pitch + (kick.adsPitch - kick.pitch) * ads;
  const yaw = kick.yaw + (kick.adsYaw - kick.yaw) * ads;
  controller.kickView(pitch, (Math.random() * 2 - 1) * yaw, kick.recoverSeconds);
}

/**
 * Spawn visual effects for another player's weapon fire.
 */
export function handleRemoteWeaponFire(event: WeaponFireEvent, remoteRenderer: RemotePlayerRenderer | null): void {
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
    case "machinegun": {
      // The event's direction carries the shot's spread; the streak leaves their gun.
      const def = WEAPONS.machinegun;
      fx.fireTracer({
        origin,
        start: remoteRenderer?.getWeaponMuzzleWorldPosition(event.entityId, dir) ?? undefined,
        direction: dir,
        color,
        maxRange: def?.range ?? 6000,
        intensity: def?.muzzleFlash?.intensity,
      });
      break;
    }
    case "riotgun": {
      // The server's own pellets when the event carries their seed; otherwise
      // (an older demo) a cone of the right size and count.
      const def = WEAPONS.riotgun;
      const pelletCount = def?.pelletCount ?? 18;
      const spreadAngle = event.pelletSpread ?? def?.spread ?? 8;
      fx.firePellets({
        origin,
        start: remoteRenderer?.getWeaponMuzzleWorldPosition(event.entityId, dir) ?? undefined,
        direction: dir,
        color,
        pelletCount,
        spreadAngle,
        maxRange: def?.range ?? 8192,
        directions:
          event.pelletSeed !== undefined
            ? serverPelletDirections(dir, event.pelletSeed, pelletCount, spreadAngle)
            : undefined,
      });
      break;
    }
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
export function handleElectroRail(
  event: ElectroRailEvent,
  localHero: boolean,
  weaponId = "electrobolt",
  followedMuzzle: Vector3 | null = null,
): void {
  const fx = getHitscanEffects();
  // Anchor the visible start to the actual gun muzzle for the local shooter. The
  // server origin is the eye (camera); a beam vertex exactly at the camera
  // projects degenerately (w≈0), smearing the near end to a screen corner and
  // making it emanate from the wrong side of the gun. The damage endpoint is
  // untouched — only the drawn start moves to the barrel (as the Voltaic beam does).
  // A player watched through their eyes is the same case, with their gun on screen.
  const muzzle = localHero ? getWeaponViewManager().getMuzzleWorldPosition() : followedMuzzle;
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
  /** Optional first-person presentation; demos/free cameras can omit it. */
  muzzleForShot?: (position: Vector3, velocity: Vector3) => Vector3 | null;
  /** Server entity ids we've spawned a visual for */
  active: Set<string>;
  /** proj_ entityId → defId (from projectile_spawn events) */
  defIds: Map<string, string>;
  /**
   * proj_ entityId → the last snapshot tick it was in (or, before its first, the
   * tick its type was first held). A projectile out of view keeps its type until
   * it has been gone longer than any projectile lives.
   */
  seenTicks: Map<string, number>;
  /** Interpolation buffer for smooth in-flight motion */
  buffer: SnapshotBuffer;
  /** Drop a despawned projectile's liquid tracking, if the game is running one. */
  forgetLiquid?: (entityId: string) => void;
}

/**
 * How long a projectile type is kept after the projectile was last in a
 * snapshot: the longest projectile lifetime (10 s, `ProjectileSystem`) and a second.
 */
const PROJECTILE_FORGET_TICKS = 11 * DEFAULT_PHYSICS_TICK_RATE;

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

    const seenBefore = sync.seenTicks.has(entityId);
    sync.seenTicks.set(entityId, state.tick);

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
        // Only a new shot starts at a gun. One coming back into view is mid-flight.
        const muzzle = seenBefore ? null : sync.muzzleForShot?.(pos, vel);
        projMgr.spawnFromServer(entityId, defId, pos, vel, muzzle);
        sync.active.add(entityId);
      } else {
        // projectile_spawn is sent once, with the projectile's first snapshot,
        // and names its type. Without it the projectile flies with no model or trail.
        log.warnRateLimited(
          "ProjectileSync",
          `${entityId} is in snapshot ${state.tick} without its projectile_spawn event; it is not drawn`,
        );
      }
    }
  }

  // Push to interpolation buffer
  sync.buffer.push(state.tick, projEntities, serverLocalTime);

  // Despawn visuals for projectiles that disappeared. Gone from the snapshot is
  // either exploded or out of view (PVS), and the client cannot tell which, so
  // the type is kept: projectile_spawn is sent once, and without it a projectile
  // coming back into view would never be drawn again.
  for (const entityId of sync.active) {
    if (!aliveThisSnapshot.has(entityId)) {
      getProjectileManager().despawnByEntityId(entityId);
      sync.active.delete(entityId);
      // Drop its liquid tracking too, or a recycled entity id inherits a
      // "was in water" flag from a projectile that already exploded.
      sync.forgetLiquid?.(entityId);
    }
  }

  // Types are forgotten by age instead: projectile_impact carries no entity id.
  for (const entityId of sync.defIds.keys()) {
    const seen = sync.seenTicks.get(entityId);
    if (seen === undefined) {
      sync.seenTicks.set(entityId, state.tick);
    } else if (state.tick - seen > PROJECTILE_FORGET_TICKS) {
      sync.defIds.delete(entityId);
      sync.seenTicks.delete(entityId);
    }
  }
}

// ── Award Event Handler ────────────────────────────────────────────

/** In-game chat event → HUD chat log (also fires during demo playback). */
// biome-ignore lint/suspicious/noExplicitAny: duck-typed snapshot event
function handleChatEvent(event: ChatSnapshotEvent): void {
  try {
    devLog(`[Chat] event ← server: ${event.senderName}: "${event.text}"`);
    const name = event.senderName || "unknown";
    const prefix = event.team === "spectator" ? "[SPEC] " : "";
    import("./FPSHud")
      .then(({ FPSHud }) => {
        FPSHud.getInstance().chat?.addMessage(prefix + name, String(event.text ?? ""), event.team ?? "", name);
      })
      .catch(() => {});
  } catch (e) {
    console.error("[Chat] event error:", e);
  }
}

/**
 * A damage event with the place the hit landed. The engine's `DamageEvent` type does not name
 * it yet; the field is optional, and an event without it is a body hit.
 */
export type LocatedDamageEvent = DamageEvent & { hitLocation?: HitLocationName };

/**
 * The player on screen dealt damage: confirm it with a sound, a crosshair flash, a
 * floating number and the cartoon hit effect.
 *
 * Runs for every hit, so it uses the modules this file already imports rather than
 * loading them on demand: `Crosshair` and `DamageNumbers` are loaded at start-up by
 * `Game.ts` and `DemoService.ts`, so a dynamic import here split nothing off and only
 * added a promise per hit.
 */
export function handleOutgoingDamage(ctx: GameEventContext, event: LocatedDamageEvent): void {
  playDamageConfirmationSound(event);
  Crosshair.getInstance().notifyHit(event.hitLocation);
  if (event.x !== undefined && event.damage > 0) {
    if (ctx.damageNumbers) {
      ctx.damageNumbers.spawn(event.x, event.y, event.z, event.damage, event.hitLocation);
    } else {
      const numbers = DamageNumbers.getInstance();
      // init() does nothing once the numbers have a scene, and spawn() does nothing
      // until they have one, so there is nothing to check first.
      const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
      if (gameScene) numbers.init(gameScene);
      numbers.spawn(event.x, event.y, event.z, event.damage, event.hitLocation);
    }
  }
  if (event.x !== undefined && ctx._cartoonHit) {
    ctx._cartoonHit.spawn(event.x, event.y, event.z, event.damage);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: duck-typed snapshot event
function handleAwardEvent(ctx: GameEventContext, event: AwardSnapshotEvent, viewPlayerId?: string): void {
  const awardType: string = event.awardType || "";
  const playerId: string = event.playerId || "";
  const playerName: string = event.playerName || "";
  const targetName: string = event.targetName || "";

  devLog(`[Award] ${playerName}: ${awardType} (target=${targetName}, value=${event.value})`);

  // Match against multiple ID formats since server/client may use different
  // formats. The banner is for whoever the view is behind: you, or the player
  // you watch.
  const viewer = viewPlayerId ?? ctx.localPlayerId;
  const isViewedPlayer = playerId === viewer || playerId === toClientKey(viewer) || toClientKey(playerId) === viewer;

  if (isViewedPlayer && awardType !== "frag") {
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
