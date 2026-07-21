/**
 * Game - Manages network simulation for FPS game
 *
 * Bridges FPSPlayer/FPSController with the authoritative simulation.
 * In single-player, runs LocalGameHost with FPSSimulation.
 * In multiplayer, uses NetworkGameHost to connect to a dedicated server.
 */

import { EngineStore } from "@babylonjs/core/Engines/engineStore";
import type { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AudioManager } from "../../engine/AudioManager";
import { CameraSystem } from "../../engine/camera";
import { setGameFrameHook } from "../../engine/camera/GameFrameHook";
import { EventBus } from "../../engine/core/EventBus";
import { log } from "../../engine/core/Log";
import { InputSystem } from "../../engine/input/InputSystem";
import { LocalGameHost } from "../../engine/network/client/hosts/LocalGameHost";
import { NetworkGameHost } from "../../engine/network/client/hosts/NetworkGameHost";
import { NetGraph } from "../../engine/network/client/NetGraph";
import { SnapshotBuffer } from "../../engine/network/client/SnapshotBuffer";
import { TransportFactory } from "../../engine/network/client/transport/Transport";
import { InputButtons } from "../../engine/network/components/InputComponent";
import type { TransformComponent } from "../../engine/network/components/TransformComponent";
import type { GameState } from "../../engine/network/core/GameState";
import type { IGameHost } from "../../engine/network/core/IGameHost";
import { MessageCodec } from "../../engine/network/protocol/MessageCodec";
import { getCollisionManager } from "../../engine/physics/CollisionManager";
import { PlayerProfile } from "../../engine/player/PlayerProfile";
import { getProjectileManager } from "../../engine/weapon/ProjectileManager";
import { getWeaponViewManager } from "../../engine/weapon/WeaponViewManager";
import { WEAPONS } from "../../shared/entities/definitions/weapons/WeaponsTable";
import { ensureClientKey } from "./ClientEntityKey";
import { V2NetworkClient } from "./client";
import { getAmmoStatus } from "./client/AmmoStatus";
import { Crosshair } from "./client/Crosshair";
import { DeathCamera } from "./client/DeathCamera";
import type { DroppedWeaponRenderer } from "./client/DroppedWeaponRenderer";
import { registerFPSActions } from "./client/FPSActions";
import { FPSHud } from "./client/FPSHud";
// Game event handling (extracted from this file)
import { type GameEventContext, handleServerStateUpdate } from "./client/GameEvents";
import { HUDState } from "./client/HUDState";
import { MatchPhase, MatchStateManager } from "./client/MatchStateManager";
import { RemotePlayerRenderer } from "./client/RemotePlayerRenderer";
import { createBSPCollisionWorld } from "./simulation/collision/BSPCollisionWorld";
import { type FPSInputCommand, FPSSimulation } from "./simulation/FPSSimulation";

export interface FPSGameConfig {
  tickRate?: number;
  maxPlayers?: number;
  /** When true, auto-join the game after map loads (skip spectator overlay) */
  autoJoin?: boolean;
  /** When true, enter pure spectator mode with auto-chase-cam (no join option) */
  watchOnly?: boolean;
}

/**
 * Player input captured from FPSController
 */
export interface PlayerInputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  fire: boolean;
  altFire: boolean;
  reload?: boolean;
  use: boolean;
  pitch: number; // Camera X rotation
  yaw: number; // Camera Y rotation
  /** Weapon slot (1-based, 0 = no change) */
  weaponSlot: number;
}

/**
 * State update for client to apply
 */
export interface PlayerStateUpdate {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  grounded: boolean;
  tick: number;

  // Advanced movement state for client effects
  isSliding: boolean;
  isCrouching: boolean;
  crouchViewOffset: number;
  wallJumpState: "none" | "available" | "charging";
  ledgeGrabState: "none" | "grabbing" | "pulling";
  actualHorizSpeed: number;
  slidePhase: number;
  ledgeGrabPhase: number;
}

export class Game {
  private static instance: Game | null = null;

  private gameHost: IGameHost | null = null;
  private simulation: FPSSimulation | null = null;
  private localPlayerId: string = "";
  private commandSeq: number = 1; // Must match InputHistory.nextSeq (starts at 1)
  private isRunning: boolean = false;
  private isNetworkMode: boolean = false;
  private serverUrl: string | null = null;

  // V2 Network Client for prediction/reconciliation
  private v2Client: V2NetworkClient | null = null;

  // Remote player model renderer
  private remoteRenderer: RemotePlayerRenderer | null = null;
  private droppedWeaponRenderer: DroppedWeaponRenderer | null = null;

  // Server-driven projectile tracking (Q3-style)
  /** Maps server projectile entity ID (e.g. 'proj_10001') → weapon defId */
  private serverProjectileDefIds: Map<string, string> = new Map();
  /** Set of server entity IDs that already have client-side visuals spawned */
  private activeServerProjectiles: Set<string> = new Set();
  /** SnapshotBuffer for projectile entity interpolation (Q3-style lerp between snapshots) */
  private projectileBuffer: SnapshotBuffer = new SnapshotBuffer();

  // Weapon state sync
  private _lastServerWeapon: string | undefined = undefined;
  /** Maps remote player entityId → currentWeapon string (for third-person rendering) */
  public readonly enemyWeapons: Map<string, string> = new Map();

  // Remote blade charge glow tracking
  /** Entity IDs currently charging their blade (for third-person glow) */
  private chargingPlayers: Set<string> = new Set();
  /** Active charge glow lights — one per charging entity */
  private chargingGlows: Map<string, PointLight> = new Map();
  /** Whether the local player is currently charging (for skipping slash trail on projectile fire) */
  private _localCharging: boolean = false;

  // Callbacks
  private onStateUpdateCallbacks: ((state: PlayerStateUpdate) => void)[] = [];

  // Death state tracking (for death camera)
  private _isPlayerDead: boolean = false;
  private _respawnRequested: boolean = false;
  private _respawnCooldownEnd: number = 0;

  // Tab-recovery: clamp deltaTime for N frames after tab-return
  private _tabReturnFrameSkips: number = 0;

  // Spectator state
  private playerState: "spectator" | "playing" = "spectator";
  private _joinPending: boolean = false;
  private _joinPendingTimeout: ReturnType<typeof setTimeout> | null = null;
  private spectatorOverlay: import("./client/SpectatorOverlay").SpectatorOverlay | null = null;
  private _joinKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _specMouseHandler: ((e: MouseEvent) => void) | null = null;
  private _scoreboardKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _scoreboardKeyUpHandler: ((e: KeyboardEvent) => void) | null = null;
  private _specCycleKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  // Chase-cam spectator (Phase 1)
  private spectatorCycling: import("./../../engine/camera/controllers/SpectatorCycling").SpectatorCycling | null = null;
  private spectatorController:
    | import("./../../engine/camera/controllers/SpectatorController").SpectatorController
    | null = null;
  private _latestGameState: GameState | null = null;

  private pendingTick: number = 0;

  // Cached effect system singletons (lazy-resolved, avoids per-frame import())
  private _gibSystem: any = null;
  private _gibSystemLoading = false; // true while import() is pending
  private _pendingGibSpawns: { x: number; y: number; z: number; vx: number; vy: number; vz: number }[] = [];
  private _damageNumbers: any = null;
  private _damageOverlay: any = null;
  private _ragdollSystem: any = null;
  private _ragdollSystemLoading = false;
  private _cartoonHit: any = null;
  private _cartoonHitLoading = false;
  /** Smoothed corpse-follow death camera. Driven by FPSController each frame. */
  private _deathCamera: DeathCamera = new DeathCamera();

  /**
   * Drive the corpse-follow death camera. Called by FPSController at the very end
   * of its update (after all its own camera writes). Returns true when the death
   * camera took over the camera, so the controller skips its fallback roll/drop
   * and the view-bob pass.
   */
  public applyDeathCamera(camera: import("./client/DeathCamera").DeathCameraTarget, dt: number): boolean {
    return this._deathCamera.update(dt, camera);
  }

  private constructor() {
    // Register as the engine's per-frame game hook so camera controllers can
    // tick the network + render remotes without importing this game (QA-WO7).
    setGameFrameHook(this);

    // Register all FPS actions + contexts with InputSystem
    registerFPSActions();

    // Dropped weapons are independent root meshes. A scene/map teardown can
    // dispose those meshes without clearing the renderer's entity registry,
    // leaving stale IDs that will never be recreated on the next map.
    EventBus.on("map:unloading", () => {
      this.droppedWeaponRenderer?.dispose();
      this.droppedWeaponRenderer = null;
    });

    // Tab-recovery: snap everything to clean state when returning from background
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.onTabReturn();
    });

    // Post-game winner showcase: spawn the winner's model (with weapon) in
    // front of the camera during PostGame; remove it when warmup begins.
    MatchStateManager.getInstance().onPhaseChange((newPhase, oldPhase) => {
      // Endgame music. This phase→music swap previously lived only in
      // NetworkGameHost, so local matches (which don't route through it) went
      // silent at match end — even though the showcase, triggered here
      // host-agnostically, still ran. Fire it here too; loadPlaylist dedupes by
      // name, so a network host also firing it is a harmless no-op.
      const audio = AudioManager.getInstance();
      if (newPhase === MatchPhase.PostGame) {
        void audio.loadPlaylist("data/endgame.playlist.json");
      } else if (oldPhase === MatchPhase.PostGame) {
        void audio.loadPlaylist("data/game.playlist.json");
      }

      import("./client/PostGameShowcase")
        .then(({ startPostGameShowcase, stopPostGameShowcase }) => {
          if (newPhase !== MatchPhase.PostGame) {
            stopPostGameShowcase();
            return;
          }
          const mgr = MatchStateManager.getInstance();
          const winnerPlayerId = mgr.resolveWinnerPlayerId();
          if (!winnerPlayerId) {
            console.log(`[PostGameShowcase] no showcase — winner=${JSON.stringify(mgr.winner)}`);
            return;
          }

          // Snapshot players are keyed "player_<id>" while match-state ids are
          // bare ("3") — normalize before the lookup.
          const winnerKey = ensureClientKey(winnerPlayerId);
          const entityId = this._latestGameState?.players.get(winnerKey)?.entityId ?? null;
          if (!entityId) {
            console.log(
              `[PostGameShowcase] no entity for winner ${winnerKey} (players: ${[...(this._latestGameState?.players.keys() ?? [])].join(", ")})`,
            );
            return;
          }

          // Winner's gun: local player → the view model's weapon; remote →
          // last weapon seen in snapshots. (localPlayerId uses the "player_<id>"
          // form, hence the normalized key.)
          const resolveWeapon = async (): Promise<string | null> => {
            if (winnerKey === this.localPlayerId) {
              const { getWeaponViewManager } = await import("../../engine/weapon/WeaponViewManager");
              return getWeaponViewManager().getDisplayedWeaponId?.() ?? null;
            }
            return this.remoteRenderer?.getKnownWeaponId(entityId) ?? null;
          };
          resolveWeapon()
            .then((weaponId) => startPostGameShowcase(this.remoteRenderer, entityId, weaponId))
            .catch((e) => log.warn("PostGameShowcase", "showcase failed:", e));
        })
        .catch((e) => log.warn("PostGameShowcase", "module load failed:", e));
    });
  }

  static getInstance(): Game {
    if (!Game.instance) {
      Game.instance = new Game();
    }
    return Game.instance;
  }

  /**
   * Tab-recovery: snap to clean state when returning from a background tab.
   * Browsers throttle rAF to ~1fps in hidden tabs, causing massive deltaTime
   * accumulation, stale interpolation buffers, and broken trails.
   */
  private onTabReturn(): void {
    if (!this.isRunning) return;
    console.log("[Game] Tab returned — resetting visual state");

    // 1. Clamp dt for next 3 frames (prevents catch-up stutter)
    this._tabReturnFrameSkips = 3;

    // 2. Clear all projectile visuals (trails, lights, meshes)
    //    Server will re-broadcast any that still exist in next snapshot
    try {
      getProjectileManager().clear();
    } catch {
      /* not initialized */
    }

    // 3. Flush projectile interpolation buffer (discard stale data)
    this.projectileBuffer.flush();

    // 4. Force local player to snap to next server position (no interpolation lag)
    this.v2Client?.forceTeleport();

    // 5. Revalidate textures/materials — GPU may have dropped them while hidden
    //    (async, runs in background — textures pop back in over 1-2 frames)
    this.revalidateAfterTabReturn();
  }

  /**
   * Revalidate GPU resources after tab return.
   * Separated from onTabReturn() because it's async.
   * Also installs WebGL context loss/restore handlers on first call.
   */
  private _contextLossHandlersInstalled = false;
  private async revalidateAfterTabReturn(): Promise<void> {
    try {
      const { CameraSystem } = await import("../../engine/camera/CameraSystem");
      const scene = CameraSystem.getInstance().getCamera()?.getScene();
      if (!scene) return;

      // Install WebGL context loss/restore handlers (once)
      if (!this._contextLossHandlersInstalled) {
        const canvas = scene.getEngine().getRenderingCanvas();
        if (canvas) {
          canvas.addEventListener("webglcontextlost", (e) => {
            console.error("[Game] ⚠️ WebGL context LOST — GPU resources destroyed");
            e.preventDefault(); // Allow browser to attempt restore
          });
          canvas.addEventListener("webglcontextrestored", () => {
            console.log("[Game] WebGL context RESTORED — revalidating materials");
            this.revalidateAfterTabReturn();
          });
          this._contextLossHandlersInstalled = true;
          console.log("[Game] WebGL context loss/restore handlers installed");
        }
      }

      const { revalidateMaterials } = await import("../../engine/weapon/EffectPreloader");
      await revalidateMaterials(scene);
      console.log("[Game] Material revalidation complete");
    } catch (err) {
      console.warn("[Game] Material revalidation failed:", err);
    }
  }

  /**
   * Initialize local game (single-player mode)
   */
  async initializeLocal(config: FPSGameConfig = {}): Promise<void> {
    // Guard against multiple initializations
    if (this.isRunning) {
      console.warn("[Game] Already initialized, skipping");
      return;
    }

    const tickRate = config.tickRate ?? 20;
    const maxPlayers = config.maxPlayers ?? 16;

    // Create simulation config
    const simConfig = {
      tickRate,
      tickDuration: 1000 / tickRate,
      maxPlayers,
      gameRules: {},
    };

    // Create LocalGameHost with FPSSimulation
    this.gameHost = new LocalGameHost(simConfig, FPSSimulation);

    // Get reference to simulation (for spawn points, collision world, etc.)
    this.simulation = (this.gameHost as LocalGameHost).getSimulation<FPSSimulation>();

    this.localPlayerId = this.gameHost.localPlayerId;
    this.isNetworkMode = false;
    this.serverUrl = null;

    // Subscribe to state updates
    this.gameHost.onStateUpdate((state: GameState) => {
      this.onServerStateUpdate(state);
    });

    // Start the host
    this.gameHost.start?.();
    this.isRunning = true;
  }

  /**
   * Initialize network game (multiplayer mode)
   * Connects to a dedicated server
   */
  async initializeNetwork(url: string, config: FPSGameConfig = {}): Promise<void> {
    // Guard against multiple initializations - shutdown first if already running
    if (this.isRunning) {
      this.shutdown();
    }

    const tickRate = config.tickRate ?? 125; // Must match server tick rate (125Hz)
    const maxPlayers = config.maxPlayers ?? 16;

    // Create simulation config for client-side prediction
    const simConfig = {
      tickRate,
      tickDuration: 1000 / tickRate,
      maxPlayers,
      gameRules: {},
    };

    try {
      // Create transport (auto-selects WebTransport or WebSocket)
      const transport = await TransportFactory.create(url);

      // Create network game host with FPSSimulation for client-side prediction
      // Cast needed due to FPSInputCommand vs Command generic variance
      const networkHost = new NetworkGameHost(transport, simConfig, FPSSimulation as any);

      // Guard against duplicate Welcome messages
      let mapLoadStarted = false;

      // Subscribe to server info to load the correct map
      networkHost.onServerInfo(async (serverInfo) => {
        // Prevent duplicate map loading (Welcome can be received multiple times)
        if (mapLoadStarted) {
          return;
        }
        mapLoadStarted = true;

        console.log(`[Game] Server map: ${serverInfo.map}`);

        // Load the server's map via console command
        try {
          const { loadClientMap } = await import("../../engine/loader/map/ClientMapLoader");
          const result = await loadClientMap(serverInfo.map);

          // Check if map load failed
          if (typeof result === "string" && result.includes("Failed")) {
            console.error(`[Game] Map load failed, disconnecting...`);
            this.shutdown();
            return;
          }

          // === CRITICAL: Set up FPS controller AFTER map loads ===
          // This prevents the race condition where scene empty/map command overrides the controller
          try {
            // Set up BSP collision for client prediction
            // This is critical for movement responsiveness (avoids "flying through walls" in prediction)
            const cm = getCollisionManager();
            if (cm.isInitialized()) {
              const collisionWorld = createBSPCollisionWorld();
              if (collisionWorld) {
                this.setCollisionWorld(collisionWorld);
              } else {
                console.warn(`[Game] BSP collision world could not be created - backend not available`);
              }

              // Trigger volumes (teleporters/jumppads) for client prediction —
              // the SAME shared TriggerTable extraction the server runs, so
              // pads and teleporters are predicted with zero reconciliation snap.
              const bsp = cm.getBsp();
              if (bsp && this.v2Client) {
                const { extractTriggerVolumes } = await import("../../shared/bsp/TriggerTable");
                this.v2Client.setTriggerVolumes(extractTriggerVolumes(bsp.entities, bsp.models));

                // Prewarm the generic teleport-ghost pool so the FIRST
                // teleport already has its afterimage.
                import("../../engine/camera/CameraSystem").then(({ CameraSystem: cs }) => {
                  const scene = cs.getInstance().getCamera()?.getScene();
                  if (scene) {
                    import("./client/TeleportEffect").then(({ TeleportEffect }) => {
                      TeleportEffect.getInstance().prewarm(scene);
                    });
                  }
                });

                // Rotate the local camera to the exit yaw when our own
                // prediction teleports (fresh inputs only, not replays), and
                // play the generic VFX: your OWN afterimage at the entry
                // (turn around and you're standing there) + speed-line bursts.
                this.v2Client.onTeleport((exitYaw, from, to, entryYaw) => {
                  import("../../engine/camera/CameraSystem").then(({ CameraSystem: cs }) => {
                    const controller = cs.getInstance().getController("fps");
                    if (controller && "setViewYaw" in controller) {
                      (controller as import("../../engine/camera/controllers/FPSController").FPSController).setViewYaw(
                        exitYaw,
                      );
                    }
                    const scene = cs.getInstance().getCamera()?.getScene();
                    if (scene) {
                      import("./client/TeleportEffect").then(({ TeleportEffect }) => {
                        TeleportEffect.getInstance().localTeleported(scene, from, to, entryYaw, exitYaw);
                      });
                    }
                  });
                });
              }
            } else {
              console.warn(`[Game] CollisionManager NOT initialized - client prediction will NOT have BSP collision!`);
            }

            const { CameraSystem } = await import("../../engine/camera/CameraSystem");
            const { FPSController } = await import("../../engine/camera/controllers/FPSController");
            const { FreeflyController } = await import("../../engine/camera/controllers/FreeflyController");
            const cameraSystem = CameraSystem.getInstance();

            // Register FPS controller (but don't activate — player starts as spectator)
            if (!cameraSystem.getController("fps")) {
              cameraSystem.registerController("fps", new FPSController());
            }

            // Register and activate freefly controller for spectator mode
            if (!cameraSystem.getController("freefly")) {
              cameraSystem.registerController("freefly", new FreeflyController());
            }
            // Start in freefly mode (spectator default)
            cameraSystem.setController("freefly");

            // WATCH mode: start auto-chase polling AFTER map loads
            // (must be here, not earlier — otherwise the freefly reset above overwrites the spectator camera)
            if (config.watchOnly) {
              const autoChaseInterval = setInterval(() => {
                if (this.spectatorCycling && this.spectatorCycling.getAliveCount() > 0) {
                  clearInterval(autoChaseInterval);
                  this.nextSpectateTarget();
                }
              }, 200);
              // Safety: stop polling after 30s
              setTimeout(() => clearInterval(autoChaseInterval), 30000);
            }

            // Auto-join if requested (lobby flow — skip spectator overlay)
            if (config.autoJoin) {
              console.log("[Game] Auto-joining game (lobby flow)");
              // Small delay to ensure everything is settled
              setTimeout(() => this.joinGame(), 200);
            }
          } catch (e) {
            console.warn(`[Game] Could not set up FPS controller after map load:`, e);
          }
        } catch (error) {
          console.error(`[Game] Failed to load map ${serverInfo.map}:`, error);
          console.log(`[Game] Disconnecting due to map load error...`);
          this.shutdown();
        }
      });

      // Set up state BEFORE connect so the onServerInfo callback can use them
      this.gameHost = networkHost;
      this.isNetworkMode = true;
      this.serverUrl = url;
      this.isRunning = true;

      // Create V2NetworkClient BEFORE connecting, so it exists when onServerInfo callback
      // sets up collision world. This fixes the race condition where setCollisionWorld()
      // was called while v2Client was null.
      this.v2Client = new V2NetworkClient({ tickRate });

      // Tell NetworkGameHost to skip its prediction - V2NetworkClient handles it
      networkHost.setExternalPrediction(true);

      // Subscribe to state updates BEFORE connect so we don't miss snapshots
      // during the handshake. onServerStateUpdate() will use this.localPlayerId,
      // which gets updated to the server-assigned ID after connect resolves.
      this.gameHost.onStateUpdate((state: GameState) => {
        this.onServerStateUpdate(state);
      });

      // Listen for server messages (queue notifications, join rejections)
      networkHost.onServerMessage((msg) => {
        console.log(`[Game] Server message [${msg.type}]: ${msg.message}`);
        // If server rejected our join, clear pending state
        if (msg.type === "queue" || msg.type === "error") {
          this._joinPending = false;
          if (this._joinPendingTimeout) {
            clearTimeout(this._joinPendingTimeout);
            this._joinPendingTimeout = null;
          }
        }
      });

      // Load player profile and connect with display name
      const profile = PlayerProfile.load();
      console.log(`[Game] Connecting as "${profile.name}" (id: ${profile.id.substring(0, 8)}...)`);

      // Connect to server (this triggers onServerInfo callback which loads map and sets collision)
      await networkHost.connect(url, profile.name);

      // Update player ID after connect (server assigns it during handshake)
      this.localPlayerId = networkHost.localPlayerId;
      this.simulation = null; // No direct simulation access in network mode

      // Initialize FPSHud (Washiki HUD system)
      const fpsHud = FPSHud.getInstance();
      await fpsHud.init();
      fpsHud.start();

      // Initialize the dynamic canvas crosshair (spread + ADS-converge + hit flash).
      // Driven per-frame from renderRemotePlayers(); update() handles its own visibility.
      import("./client/Crosshair").then((m) => m.Crosshair.getInstance().init());

      // Initialize NetGraph overlay (cl_netgraph CVar)
      NetGraph.init();

      // ── Spectator Mode: show join overlay on connect ──────────
      this.playerState = "spectator";

      // Only show spectator overlay if NOT auto-joining
      if (!config.autoJoin) {
        const { SpectatorOverlay } = await import("./client/SpectatorOverlay");
        this.spectatorOverlay = new SpectatorOverlay();

        if (config.watchOnly) {
          // WATCH mode: pure spectator, start in freefly until chase-cam target available
          this.spectatorOverlay.setMode("freefly");
        } else {
          // Normal connect: show join/spectate choice
          this.spectatorOverlay.setMode("join-overlay");
        }

        this.spectatorOverlay.onJoinGame(() => {
          this.joinGame();
        });
        this.spectatorOverlay.onSpectate(() => {
          // Switch to freefly spectator (no entity, just camera)
          this.spectatorOverlay?.setMode("freefly");
          this.switchToFreeflyCamera();
        });

        // Wire next/prev player cycling
        this.spectatorOverlay.onNextPlayer(() => {
          this.nextSpectateTarget();
        });
        this.spectatorOverlay.onPrevPlayer(() => {
          this.prevSpectateTarget();
        });
      } // end if (!config.autoJoin)

      // ── Initialize SpectatorCycling and SpectatorController ──
      const { SpectatorCycling } = await import("../../engine/camera/controllers/SpectatorCycling");
      const { SpectatorController } = await import("../../engine/camera/controllers/SpectatorController");
      this.spectatorCycling = new SpectatorCycling();
      this.spectatorController = new SpectatorController();

      // Register the spectator camera controller
      const camSys = CameraSystem.getInstance();
      camSys.registerController("spectator", this.spectatorController);

      // Set up target provider — reads entity position/rotation from latest GameState
      this.spectatorController.setTargetProvider((entityId: string) => {
        const state = this._latestGameState;
        if (!state) return null;
        const entity = state.entities.get(entityId);
        if (!entity) return null;
        const transform = entity.getComponent("transform") as
          | { position?: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number } }
          | undefined;
        if (!transform?.position) return null;
        return {
          x: transform.position.x,
          y: transform.position.y,
          z: transform.position.z,
          yaw: transform.rotation?.y ?? 0,
          pitch: transform.rotation?.x ?? 0,
        };
      });

      // ── Spectator cycling keyboard handler (arrows + Space) ──
      this._specCycleKeyHandler = (e: KeyboardEvent) => {
        if (this.playerState !== "spectator") return;
        if (e.code === "ArrowRight") {
          e.preventDefault();
          this.nextSpectateTarget();
        } else if (e.code === "ArrowLeft") {
          e.preventDefault();
          this.prevSpectateTarget();
        } else if (e.code === "Space" || e.code === "Backspace") {
          // Return to freefly from chase-cam
          if (this.spectatorCycling?.getTargetEntityId()) {
            e.preventDefault();
            this.exitChaseCam();
          }
        }
      };
      document.addEventListener("keydown", this._specCycleKeyHandler);

      // ── Mouse1 (left click) handler: chase-cam ──
      // Matches the freefly cue label ("MOUSE1 Chase Player"). Enter chase from
      // freefly, or advance to the next player while already chasing; ←/→ cycle
      // and Space/Backspace returns to freefly. Ignored until the pointer is
      // locked so the click that engages mouselook doesn't jump straight into a
      // chase. Middle-click is reserved for "fly down" (crouch), so it is NOT a
      // chase alias here.
      this._specMouseHandler = (e: MouseEvent) => {
        if (this.playerState !== "spectator") return;
        if (e.button !== 0) return;
        // Only once the pointer is locked (freefly mouselook active).
        if (!document.pointerLockElement) return;
        e.preventDefault();
        this.nextSpectateTarget();
      };
      document.addEventListener("mousedown", this._specMouseHandler);

      // ── J key shortcut to join game from spectator mode ──
      // Uses InputSystem's raw key state (this runs in an event handler, not per-frame)
      this._joinKeyHandler = (_e: KeyboardEvent) => {
        const input = InputSystem.getInstance();
        if (input.isKeyDown("KeyJ") && this.playerState === "spectator") {
          this.joinGame();
        }
      };
      document.addEventListener("keydown", this._joinKeyHandler);

      // ── Tab key: hold-to-show scoreboard (Quake style) ──
      this._scoreboardKeyHandler = (e: KeyboardEvent) => {
        if (e.code === "Tab") {
          e.preventDefault();
          const hud = FPSHud.getInstance();
          hud.scoreboard?.show();
        }
      };
      this._scoreboardKeyUpHandler = (e: KeyboardEvent) => {
        if (e.code === "Tab") {
          e.preventDefault();
          const hud = FPSHud.getInstance();
          hud.scoreboard?.hide();
        }
      };
      document.addEventListener("keydown", this._scoreboardKeyHandler);
      document.addEventListener("keyup", this._scoreboardKeyUpHandler);
    } catch (error) {
      console.error(`[Game] Failed to connect to ${url}:`, error);
      throw error;
    }
  }

  /**
   * Check if running in network mode
   */
  isConnectedToServer(): boolean {
    return this.isNetworkMode && this.isRunning;
  }

  /**
   * Check if local player is currently dead (for death camera)
   */
  isPlayerDead(): boolean {
    return this._isPlayerDead;
  }

  /**
   * Get current weapon ID (for crosshair lookup)
   */
  getCurrentWeaponId(): string {
    return this._lastServerWeapon || "gunblade";
  }

  /**
   * Get current server URL (if connected)
   */
  getServerUrl(): string | null {
    return this.serverUrl;
  }

  /**
   * Check if currently spectating
   */
  isSpectating(): boolean {
    return this.playerState === "spectator";
  }

  /**
   * Get current player state
   */
  getPlayerState(): "spectator" | "playing" {
    return this.playerState;
  }

  // ========================================================================
  // Spectator Mode
  // ========================================================================

  /**
   * joinGame — request to transition from spectator to playing.
   * Sends JoinGame to server. Actual transition happens server-confirmed
   * when our entity appears in the snapshot (see completeJoinGame).
   */
  async joinGame(): Promise<void> {
    if (this.playerState === "playing") {
      console.log("[Game] joinGame() — already playing, skipping");
      return;
    }
    if (this._joinPending) {
      console.log("[Game] joinGame() — join already pending, skipping");
      return;
    }
    if (!this.gameHost || !this.isNetworkMode) {
      console.log("[Game] joinGame() — no gameHost or not network mode");
      return;
    }
    console.log("[Game] joinGame() — sending join request to server");

    const networkHost = this.gameHost as import("../../engine/network/client/hosts/NetworkGameHost").NetworkGameHost;

    // Tell server we want to join — server decides if we can
    networkHost.sendJoinGame();
    this._joinPending = true;

    // Timeout: revert if server doesn't respond within 5 seconds
    this._joinPendingTimeout = setTimeout(() => {
      if (this._joinPending) {
        console.log("[Game] joinGame() — timed out waiting for server confirmation");
        this._joinPending = false;
      }
    }, 5000);
  }

  /**
   * completeJoinGame — called when server confirmed our join
   * (our entity appeared in snapshot). Switches camera and state.
   */
  private async completeJoinGame(): Promise<void> {
    this._joinPending = false;
    if (this._joinPendingTimeout) {
      clearTimeout(this._joinPendingTimeout);
      this._joinPendingTimeout = null;
    }

    console.log("[Game] completeJoinGame() — server confirmed, transitioning to playing");

    // Clear any active chase-cam state before switching
    this.spectatorCycling?.clearTarget();
    this.spectatorController?.clearSpectateTarget();

    // Switch to FPS camera controller
    try {
      const { CameraSystem } = await import("../../engine/camera/CameraSystem");
      const { FPSController } = await import("../../engine/camera/controllers/FPSController");
      const cameraSystem = CameraSystem.getInstance();

      if (!cameraSystem.getController("fps")) {
        cameraSystem.registerController("fps", new FPSController());
      }
      cameraSystem.setController("fps");

      // Enable network mode on FPS controller
      const controller = cameraSystem.getActiveController();
      if (controller && controller.type === "fps" && typeof (controller as any).enableNetworkMode === "function") {
        (controller as any).enableNetworkMode();
      }
    } catch (e) {
      console.warn("[Game] Could not switch to FPS camera:", e);
    }

    // Update state
    this.playerState = "playing";
    this.spectatorOverlay?.setMode("hidden");

    // Initialize weapon view manager with the now-active FPS camera
    try {
      const { CameraSystem } = await import("../../engine/camera/CameraSystem");
      const { getWeaponViewManager } = await import("../../engine/weapon/WeaponViewManager");
      const { getProjectileManager } = await import("../../engine/weapon/ProjectileManager");
      const { initializeEntityDefs } = await import("../../shared/entities");
      const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");

      const camera = CameraSystem.getInstance().getCamera();
      const scene = camera?.getScene();

      if (scene && camera instanceof FreeCamera) {
        initializeEntityDefs();
        const wvm = getWeaponViewManager();
        wvm.init(scene, camera);
        console.log("[Game] completeJoinGame() — WVM initialized");
        wvm.loadWeapon(this._lastServerWeapon || "blade").then((success) => {
          console.log(`[Game] completeJoinGame() — initial weapon loadWeapon result: ${success}`);
        });

        // Preload projectile models (independent of weapon load)
        const projMgr = getProjectileManager();
        Promise.all([
          projMgr.preloadModel("plasma_bolt"),
          projMgr.preloadModel("grenade"),
          projMgr.preloadModel("rocket"),
          projMgr.preloadModel("gunblade_blast"),
          projMgr.preloadModel("blade_blast"),
        ]).catch((err) => console.warn("[Game] Projectile preload error:", err));
      }
    } catch (e) {
      console.warn("[Game] Failed to init weapon view:", e);
    }

    // Request pointer lock for FPS controls
    const canvas = document.querySelector("canvas");
    if (canvas) {
      canvas.requestPointerLock();
    }

    console.log("[Game] Joined game (server-confirmed)");
  }

  /**
   * Send an in-game chat message (server sanitizes/rate-limits and
   * rebroadcasts as a `chat` snapshot event). Called by the HUD chat widget.
   */
  sendChat(text: string): void {
    if (!this.gameHost || !this.isNetworkMode) {
      console.warn(`[Chat] send dropped — gameHost=${!!this.gameHost} networkMode=${this.isNetworkMode}`);
      return;
    }
    console.log(`[Chat] send → server: "${text}"`);
    const networkHost = this.gameHost as import("../../engine/network/client/hosts/NetworkGameHost").NetworkGameHost;
    networkHost.sendChat(text);
  }

  /**
   * goSpectator — transition from playing to spectator.
   * Sends Spectate to server, switches camera to freefly, shows overlay.
   */
  async goSpectator(): Promise<void> {
    if (this.playerState === "spectator") return;
    if (!this.gameHost || !this.isNetworkMode) return;

    const networkHost = this.gameHost as import("../../engine/network/client/hosts/NetworkGameHost").NetworkGameHost;

    // Tell server to remove our entity
    networkHost.sendSpectate();

    // Switch to freefly camera
    this.switchToFreeflyCamera();

    // Update state
    this.playerState = "spectator";
    this.spectatorOverlay?.setMode("freefly");

    // Hide weapon view model
    import("../../engine/weapon/WeaponViewManager").then((m) => {
      m.getWeaponViewManager().setVisible(false);
    });

    // Hide speedometer (prevent overlap with spectator overlay)
    const speedEl = document.getElementById("fps-speed-display");
    if (speedEl) speedEl.remove();
    // Reset static refs so a fresh widget is created on rejoin
    (await import("../../engine/camera/controllers/FPSController")).FPSController.resetSpeedDisplay?.();

    // Release pointer lock
    document.exitPointerLock();

    console.log("[Game] Now spectating");
  }

  /**
   * Chase-cam: start following a specific player entity.
   */
  spectatePlayer(entityId: string): void {
    if (!this.spectatorController || !this.spectatorCycling) return;
    this.spectatorCycling.setTarget(entityId);
    this.spectatorController.setSpectateTarget(entityId);
    this.spectatorOverlay?.setMode("first-person");
    this.spectatorOverlay?.setSpectatingTarget(this.spectatorCycling.getPlayerName(entityId));
    CameraSystem.getInstance().setController("spectator");
    console.log(`[Game] Now spectating player: ${entityId}`);
  }

  /**
   * Chase-cam: cycle to next alive player.
   */
  nextSpectateTarget(): void {
    if (!this.spectatorCycling) return;
    const next = this.spectatorCycling.next();
    if (next) {
      this.spectatePlayer(next);
    }
  }

  /**
   * Chase-cam: cycle to previous alive player.
   */
  prevSpectateTarget(): void {
    if (!this.spectatorCycling) return;
    const prev = this.spectatorCycling.prev();
    if (prev) {
      this.spectatePlayer(prev);
    }
  }

  /**
   * Exit chase-cam: return to freefly spectator mode.
   */
  exitChaseCam(): void {
    this.spectatorCycling?.clearTarget();
    this.spectatorController?.clearSpectateTarget();
    this.spectatorOverlay?.setMode("freefly");
    this.switchToFreeflyCamera();
    console.log("[Game] Returned to freefly spectator");
  }

  /**
   * Switch the active camera to freefly controller (for spectator mode).
   */
  private async switchToFreeflyCamera(): Promise<void> {
    try {
      const { CameraSystem } = await import("../../engine/camera/CameraSystem");
      const { FreeflyController } = await import("../../engine/camera/controllers/FreeflyController");
      const cameraSystem = CameraSystem.getInstance();

      if (!cameraSystem.getController("freefly")) {
        cameraSystem.registerController("freefly", new FreeflyController());
      }
      cameraSystem.setController("freefly");

      console.log("[Game] Switched to freefly camera");
    } catch (e) {
      console.warn("[Game] Could not switch to freefly camera:", e);
    }
  }

  /**
   * Spawn local player in simulation
   * @param spawnPosition Optional spawn position (uses random spawn point if not provided)
   */
  spawnLocalPlayer(spawnPosition?: { x: number; y: number; z: number }): void {
    if (!this.simulation) {
      console.error("[Game] Cannot spawn - not initialized");
      return;
    }

    // Spawn player in simulation
    const entity = this.simulation.spawnPlayer(this.localPlayerId);

    // Override spawn position if provided
    if (spawnPosition) {
      const transform = entity.getComponent<TransformComponent>("transform");
      if (transform) {
        transform.position = { ...spawnPosition };
      }
    }
  }

  /**
   * Send player input to simulation
   * Call this each frame from FPSController
   */
  sendInput(input: PlayerInputState): void {
    if (!this.gameHost || !this.isRunning) {
      return;
    }

    // Spectators don't send input at all
    if (this.playerState === "spectator") {
      return;
    }

    // Post-game screen: gameplay is over — strip movement/actions locally so
    // prediction matches the server's input freeze (look-around stays free).
    if (MatchStateManager.getInstance().isPostGame()) {
      input.forward = false;
      input.backward = false;
      input.left = false;
      input.right = false;
      input.jump = false;
      input.crouch = false;
      input.sprint = false;
      input.fire = false;
      input.altFire = false;
      input.reload = false;
      input.use = false;
      input.weaponSlot = 0; // no weapon switching either
    }

    // While dead, check for respawn input and strip ALL gameplay input.
    // Respawn is triggered via a dedicated RequestSpawn reliable message.
    if (this._isPlayerDead) {
      // Send RequestSpawn if cooldown expired and fire/jump pressed
      if (!this._respawnRequested && Date.now() >= this._respawnCooldownEnd) {
        if (input.fire || input.jump) {
          this.sendRequestSpawn();
          this._respawnRequested = true;
        }
      }

      // Strip ALL input — no corpse movement, no fire processing
      input.forward = false;
      input.backward = false;
      input.left = false;
      input.right = false;
      input.jump = false;
      input.crouch = false;
      input.sprint = false;
      input.fire = false;
      input.altFire = false;
      input.reload = false;
    }

    // Convert input state to button flags
    let buttons = 0;
    if (input.forward) buttons |= InputButtons.FORWARD;
    if (input.backward) buttons |= InputButtons.BACK;
    if (input.left) buttons |= InputButtons.LEFT;
    if (input.right) buttons |= InputButtons.RIGHT;
    if (input.jump) buttons |= InputButtons.JUMP;
    if (input.crouch) buttons |= InputButtons.CROUCH;
    if (input.sprint) buttons |= InputButtons.SPRINT;
    if (input.fire) buttons |= InputButtons.FIRE;
    if (input.altFire) buttons |= InputButtons.ALT_FIRE;
    if (input.reload) buttons |= InputButtons.RELOAD;
    if (input.use) buttons |= InputButtons.USE;

    // Build world-space direction from buttons using Babylon.js LEFT-HANDED coordinate system
    // In left-handed Y rotation: forward = (sin(yaw), 0, cos(yaw)), right = (cos(yaw), 0, -sin(yaw))
    // This matches what camera.getDirection(Forward/Right) returns in the local code.
    const cosYaw = Math.cos(input.yaw);
    const sinYaw = Math.sin(input.yaw);

    // Forward direction in Babylon left-handed
    const forwardX = sinYaw;
    const forwardZ = cosYaw;
    // Right direction in Babylon left-handed (90° clockwise from forward)
    const rightX = cosYaw;
    const rightZ = -sinYaw;

    // Build world direction from local input
    let dirX = 0;
    let dirZ = 0;
    if (input.forward) {
      dirX += forwardX;
      dirZ += forwardZ;
    }
    if (input.backward) {
      dirX -= forwardX;
      dirZ -= forwardZ;
    }
    if (input.left) {
      dirX -= rightX;
      dirZ -= rightZ;
    }
    if (input.right) {
      dirX += rightX;
      dirZ += rightZ;
    }

    // Normalize the final direction
    const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (dirLen > 0) {
      dirX /= dirLen;
      dirZ /= dirLen;
    }

    // Create input command
    const cmd: FPSInputCommand = {
      type: "fps_input",
      playerId: this.localPlayerId,
      tick: this.gameHost.currentTick,
      seq: this.commandSeq++,
      direction: { x: dirX, y: 0, z: dirZ },
      pitch: input.pitch,
      yaw: input.yaw,
      buttons,
      weaponSlot: input.weaponSlot || 0,
      serialize: () => new Uint8Array(), // TODO: Implement for network
    };

    // === V2 CLIENT: Process input for instant local prediction ===
    if (this.v2Client && this.isNetworkMode) {
      this.v2Client.processInput({
        direction: { x: dirX, y: 0, z: dirZ },
        pitch: input.pitch,
        yaw: input.yaw,
        buttons,
        clientTick: this.gameHost.currentTick,
      });
    }

    // Send to host (runs simulation tick)
    this.gameHost.sendCommand(cmd);
    NetGraph.recordCommandSent();
  }

  /**
   * Subscribe to player state updates
   * Returns unsubscribe function
   */
  onPlayerStateUpdate(callback: (state: PlayerStateUpdate) => void): () => void {
    this.onStateUpdateCallbacks.push(callback);
    return () => {
      const index = this.onStateUpdateCallbacks.indexOf(callback);
      if (index >= 0) {
        this.onStateUpdateCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Process buffered server snapshots (called from frame loop BEFORE input processing)
   *
   * This ensures reconciliation happens at a deterministic point in the frame,
   * preventing mid-frame camera position discontinuities that cause jitter.
   */
  processSnapshots(): void {
    if (!this.v2Client || !this.isNetworkMode) return;

    // Process buffered snapshots in V2NetworkClient
    const processed = this.v2Client.processBufferedSnapshots();
    if (!processed) return;

    // Fire callbacks with reconciled state
    const v2State = this.v2Client.getState();
    // Use client-predicted movement state for visual effects (crouchslide, walljump, etc.)
    // These come from the local FPSMovementProfile.simulate() - same code as server,
    // zero bandwidth cost, zero latency for visual feedback.
    const ms = this.v2Client.getMovementState();
    const update: PlayerStateUpdate = {
      position: v2State.position,
      velocity: v2State.velocity,
      grounded: v2State.grounded,
      tick: this.pendingTick,
      isSliding: ms.isSliding,
      isCrouching: ms.isCrouching,
      crouchViewOffset: ms.crouchViewOffset,
      wallJumpState: ms.wallJumpState as any,
      ledgeGrabState: ms.ledgeGrabState as any,
      actualHorizSpeed: ms.actualHorizSpeed,
      slidePhase: ms.slidePhase,
      ledgeGrabPhase: ms.ledgeGrabPhase,
    };

    for (const callback of this.onStateUpdateCallbacks) {
      callback(update);
    }
  }

  /**
   * Render remote player models using interpolated positions from the snapshot buffer.
   * Call once per frame AFTER processSnapshots() for smooth remote player movement.
   */
  renderRemotePlayers(): void {
    if (this.remoteRenderer) {
      this.remoteRenderer.render();
    }

    // Render server-driven projectiles with interpolated positions (Q3-style)
    this.renderServerProjectiles();

    // Update particle/effect systems that need per-frame ticking
    let dtSec = (EngineStore.LastCreatedEngine?.getDeltaTime() ?? 16) / 1000;
    // Tab-recovery: clamp dt to prevent catch-up stutter
    if (this._tabReturnFrameSkips > 0) {
      dtSec = 0.016;
      this._tabReturnFrameSkips--;
    }

    // Update gib physics (gravity, bouncing, tumble, fade)
    if (!this._gibSystem && !this._gibSystemLoading) {
      // Eagerly init on first frame so it's ready for death events
      this._gibSystemLoading = true;
      import("./client/GibSystem")
        .then((m) => {
          const gibs = m.GibSystem.getInstance();
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) {
            gibs.init(gameScene); // init() handles scene changes gracefully
          }
          if (gibs["scene"]) {
            this._gibSystem = gibs;
            console.log(`[GibSystem] Initialized, flushing ${this._pendingGibSpawns.length} pending spawns`);
            // Flush any gib spawns that queued while loading
            for (const pending of this._pendingGibSpawns) {
              gibs.spawn(pending.x, pending.y, pending.z, pending.vx, pending.vy, pending.vz);
            }
            this._pendingGibSpawns = [];
          } else {
            // Scene not ready yet — allow retry on next frame
            console.log(`[GibSystem] Scene not ready, will retry next frame`);
            this._gibSystemLoading = false;
          }
        })
        .catch((e) => {
          console.error("[GibSystem] Failed to load GibSystem module:", e);
          this._gibSystemLoading = false;
        });
    } else if (this._gibSystem) {
      this._gibSystem.update(dtSec);
    }

    // Update ragdoll physics (Havok-driven skeleton ragdolls)
    if (!this._ragdollSystem && !this._ragdollSystemLoading) {
      this._ragdollSystemLoading = true;
      import("./client/RagdollSystem")
        .then((m) => {
          const ragdolls = m.RagdollSystem.getInstance();
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) {
            ragdolls.init(gameScene);
            // Wire gib explosion callback (Warsow-style ragdoll cleanup)
            if (this._gibSystem) {
              ragdolls.setGibCallback((x: number, y: number, z: number, vx: number, vy: number, vz: number) => {
                this._gibSystem?.spawn(x, y, z, vx, vy, vz);
              });
            }
            this._ragdollSystem = ragdolls;
            console.log("[RagdollSystem] Initialized");
          } else {
            console.log("[RagdollSystem] Scene not ready, will retry");
            this._ragdollSystemLoading = false;
          }
        })
        .catch((e) => {
          console.error("[RagdollSystem] Failed to load:", e);
          this._ragdollSystemLoading = false;
        });
    } else if (this._ragdollSystem) {
      this._ragdollSystem.update(dtSec);
    }

    // Update floating damage numbers (float upward, fade out)
    if (this._damageNumbers) {
      this._damageNumbers.update(dtSec);
    } else {
      import("./client/DamageNumbers").then((m) => {
        const dn = m.DamageNumbers.getInstance();
        if (dn["scene"]) this._damageNumbers = dn;
      });
    }

    // Update damage overlay (directional red triangles + vignette)
    if (this._damageOverlay) {
      this._damageOverlay.update(dtSec);
    } else {
      import("../../engine/ui/hud/DamageOverlay").then((m) => {
        this._damageOverlay = m.DamageOverlay.getInstance();
      });
    }

    // Update cartoon hit effects (Warsow-style POW! sprites)
    if (!this._cartoonHit && !this._cartoonHitLoading) {
      this._cartoonHitLoading = true;
      import("./client/CartoonHitEffect")
        .then((m) => {
          const ch = m.CartoonHitEffect.getInstance();
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (gameScene) {
            ch.init(gameScene);
            this._cartoonHit = ch;
            console.log("[CartoonHitEffect] Initialized");
          } else {
            this._cartoonHitLoading = false;
          }
        })
        .catch((e) => {
          console.error("[CartoonHitEffect] Failed to load:", e);
          this._cartoonHitLoading = false;
        });
    } else if (this._cartoonHit) {
      this._cartoonHit.update(dtSec);
    }

    // Update charge glow lights (pulsing red glow for remote players charging blade)
    if (this.chargingPlayers.size > 0) {
      const now = performance.now() / 1000;
      // Pulse: intensity oscillates between 4 and 12
      const pulse = 8 + 4 * Math.sin(now * 8);
      for (const [, light] of this.chargingGlows) {
        light.intensity = pulse;
      }
    }

    // Render network diagnostics overlay (if cl_netgraph > 0)
    NetGraph.render();

    // Drive the dynamic crosshair: COD-style spread that widens with movement and
    // converges to center when ADS'ing, plus a red-X override when out of ammo.
    const hud = HUDState.getInstance();
    const weaponId = this.getCurrentWeaponId();
    const crosshairCfg = WEAPONS[weaponId]?.crosshair ?? null;
    const adsProgress = getWeaponViewManager().getAdsProgress();
    const horizSpeed = this.v2Client?.getMovementState().actualHorizSpeed ?? 0;
    const ammoStatus = getAmmoStatus(weaponId, hud.ammo[weaponId]);
    Crosshair.getInstance().update(
      adsProgress,
      horizSpeed,
      crosshairCfg,
      this._isPlayerDead,
      this.playerState === "playing",
      ammoStatus.outOfAmmo,
    );
  }

  /**
   * Per-frame interpolated rendering of server-driven projectiles.
   * Samples the SnapshotBuffer for each active projectile entity,
   * giving smooth lerp between two snapshots (same as remote players).
   */
  private renderServerProjectiles(): void {
    const projMgr = getProjectileManager();
    for (const entityId of this.activeServerProjectiles) {
      const interp = this.projectileBuffer.sample(entityId);
      if (!interp) continue;
      projMgr.updateServerPosition(
        entityId,
        new Vector3(interp.x, interp.y, interp.z),
        new Vector3(interp.vx, interp.vy, interp.vz),
      );
    }
  }

  /**
   * Get V2Client's current predicted movement state.
   * Unlike onPlayerStateUpdate (which fires only on snapshot frames, BEFORE the tick loop),
   * this returns the CURRENT state AFTER the tick loop, in sync with getLocalPlayerPosition().
   * Essential for keeping view bob, animations, and camera effects aligned with camera position.
   */
  getCurrentMovementState(): PlayerStateUpdate | null {
    if (!this.v2Client) return null;
    const v2State = this.v2Client.getState();
    const ms = this.v2Client.getMovementState();
    return {
      position: v2State.position,
      velocity: v2State.velocity,
      grounded: v2State.grounded,
      tick: 0, // Not used for view effects
      isSliding: ms.isSliding,
      isCrouching: ms.isCrouching,
      crouchViewOffset: ms.crouchViewOffset,
      wallJumpState: ms.wallJumpState as any,
      ledgeGrabState: ms.ledgeGrabState as any,
      actualHorizSpeed: ms.actualHorizSpeed,
      slidePhase: ms.slidePhase,
      ledgeGrabPhase: ms.ledgeGrabPhase,
    };
  }

  /**
   * Get current local player position from simulation
   * Uses interpolation for smooth rendering between snapshots
   */
  getLocalPlayerPosition(): { x: number; y: number; z: number } | null {
    if (!this.gameHost) {
      return null;
    }

    // === V2 CLIENT: Use predicted position for instant, accurate rendering ===
    // When V2NetworkClient is active, it owns the authoritative client position.
    // NetworkGameHost.localState is NOT updated (predictLocally is skipped).
    if (this.v2Client && this.isNetworkMode) {
      // Wait for first server snapshot - position is (0,0,0) until then
      if (!this.v2Client.hasValidPosition()) {
        return null; // Camera will wait for valid position
      }
      // Decay the visual smoothing offset each frame (absorbs reconciliation jitter)
      const engine = EngineStore.LastCreatedEngine;
      let dt = engine ? engine.getDeltaTime() / 1000 : 0.016;
      // Tab-recovery: clamp dt for visual offset decay too
      if (this._tabReturnFrameSkips > 0) dt = 0.016;
      this.v2Client.decayVisualOffset(dt);
      // Use visually smoothed position for camera rendering
      const pos = this.v2Client.getVisualPosition();
      return { x: pos.x, y: pos.y, z: pos.z };
    }

    const state = this.gameHost.getLocalState();
    const player = state.players.get(this.localPlayerId);
    if (!player) {
      if (Math.random() < 0.01) {
        console.log(`[Game] getLocalPlayerPosition: no player for ${this.localPlayerId}`);
      }
      return null;
    }

    // For NetworkGameHost (legacy path without V2Client), use interpolated entity
    const networkHost = this.gameHost as any;
    if (typeof networkHost.getInterpolatedEntity === "function") {
      const interpolatedEntity = networkHost.getInterpolatedEntity(player.entityId);
      if (interpolatedEntity) {
        const transform = interpolatedEntity.getComponent("transform") as any;
        if (transform?.position) {
          return {
            x: transform.position.x,
            y: transform.position.y,
            z: transform.position.z,
          };
        }
      }
    }

    // For LocalGameHost, use interpolated position
    const localHost = this.gameHost as LocalGameHost;
    if (localHost.getInterpolatedPosition) {
      const interpPos = localHost.getInterpolatedPosition(player.entityId);
      if (interpPos) return interpPos;
    }

    // Fallback to discrete position
    const entity = state.entities.get(player.entityId);
    if (!entity) {
      return null;
    }

    const transform = entity.getComponent<TransformComponent>("transform");
    if (!transform) {
      return null;
    }

    return { ...transform.position };
  }

  /**
   * Get current tick
   */
  getCurrentTick(): number {
    return this.gameHost?.currentTick ?? 0;
  }

  /**
   * Check if running
   */
  isGameRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get local player ID
   */
  getLocalPlayerId(): string {
    return this.localPlayerId;
  }

  /**
   * Get current ping to server in ms (-1 if not connected or local)
   */
  getPing(): number {
    if (!this.isNetworkMode || !this.gameHost) return -1;
    const state = this.gameHost.getLocalState();
    if (!state) return -1;
    const localPlayer = state.players.get(this.localPlayerId);
    return localPlayer?.ping ?? -1;
  }

  /**
   * Send ready signal to server (for warmup phase)
   */
  sendReady(): void {
    if (!this.isNetworkMode || !this.gameHost) {
      console.log("[Game] Cannot send ready — not connected");
      return;
    }

    const data = MessageCodec.encodeReady();
    // Send via the NetworkGameHost's transport
    const networkHost = this.gameHost as any;
    if (networkHost.transport && typeof networkHost.transport.send === "function") {
      networkHost.transport.send(data, true); // Reliable
      MatchStateManager.getInstance().setReady(true);
      console.log("[Game] Sent ready signal to server");
    }
  }

  /**
   * Send respawn request to server (after death cooldown)
   */
  private sendRequestSpawn(): void {
    if (!this.isNetworkMode || !this.gameHost) return;

    const data = MessageCodec.encodeRequestSpawn();
    const networkHost = this.gameHost as any;
    if (networkHost.transport && typeof networkHost.transport.send === "function") {
      networkHost.transport.send(data, true); // Reliable
      console.log("[Game] Sent RequestSpawn to server");
    }
  }

  /**
   * Shutdown game
   */
  shutdown(): void {
    if (this.gameHost) {
      // Disconnect if in network mode
      if (this.isNetworkMode && "disconnect" in this.gameHost) {
        (this.gameHost as any).disconnect();
      }
      this.gameHost.stop?.();
      this.gameHost = null;
    }
    this.simulation = null;
    this.isRunning = false;
    this.isNetworkMode = false;
    this.serverUrl = null;
    this.commandSeq = 1; // Must match InputHistory.nextSeq (starts at 1)
    this.onStateUpdateCallbacks = [];
    this._latestGameState = null;
    this.spectatorCycling?.reset();
    this.spectatorCycling = null;
    this.spectatorController?.dispose();
    this.spectatorController = null;
    this.droppedWeaponRenderer?.dispose();
    this.droppedWeaponRenderer = null;

    // Cleanup event listeners
    if (this._joinKeyHandler) {
      document.removeEventListener("keydown", this._joinKeyHandler);
      this._joinKeyHandler = null;
    }
    if (this._scoreboardKeyHandler) {
      document.removeEventListener("keydown", this._scoreboardKeyHandler);
      this._scoreboardKeyHandler = null;
    }
    if (this._scoreboardKeyUpHandler) {
      document.removeEventListener("keyup", this._scoreboardKeyUpHandler);
      this._scoreboardKeyUpHandler = null;
    }
    if (this._specCycleKeyHandler) {
      document.removeEventListener("keydown", this._specCycleKeyHandler);
      this._specCycleKeyHandler = null;
    }
    if (this._specMouseHandler) {
      document.removeEventListener("mousedown", this._specMouseHandler);
      this._specMouseHandler = null;
    }

    // Cleanup match state and HUD

    FPSHud.getInstance().destroy();
    Crosshair.getInstance().dispose();
    MatchStateManager.destroy();
    HUDState.destroy();

    console.log("[Game] Shutdown complete");
  } // ========================================================================
  // Event Context
  // ========================================================================

  /** Lazily provide the event context (avoids creating a new object each snapshot) */
  private _eventCtx: GameEventContext | null = null;

  private getEventContext(): GameEventContext {
    if (!this._eventCtx) {
      this._eventCtx = {
        get localPlayerId() {
          return Game.getInstance().localPlayerId;
        },
        set localPlayerId(v) {
          Game.getInstance().localPlayerId = v;
        },
        isNetworkMode: this.isNetworkMode,
        gameHost: this.gameHost,
        v2Client: this.v2Client,
        get remoteRenderer() {
          return Game.getInstance().remoteRenderer;
        },
        set remoteRenderer(v) {
          Game.getInstance().remoteRenderer = v;
        },
        get droppedWeaponRenderer() {
          return Game.getInstance().droppedWeaponRenderer;
        },
        set droppedWeaponRenderer(v) {
          Game.getInstance().droppedWeaponRenderer = v;
        },
        _lastServerWeapon: this._lastServerWeapon,
        enemyWeapons: this.enemyWeapons,
        _localCharging: this._localCharging,
        chargingPlayers: this.chargingPlayers,
        chargingGlows: this.chargingGlows,
        serverProjectileDefIds: this.serverProjectileDefIds,
        activeServerProjectiles: this.activeServerProjectiles,
        projectileBuffer: this.projectileBuffer,
        get _isPlayerDead() {
          return Game.getInstance()._isPlayerDead;
        },
        set _isPlayerDead(v) {
          Game.getInstance()._isPlayerDead = v;
        },
        get _respawnRequested() {
          return Game.getInstance()._respawnRequested;
        },
        set _respawnRequested(v) {
          Game.getInstance()._respawnRequested = v;
        },
        get _respawnCooldownEnd() {
          return Game.getInstance()._respawnCooldownEnd;
        },
        set _respawnCooldownEnd(v) {
          Game.getInstance()._respawnCooldownEnd = v;
        },
        _gibSystem: this._gibSystem,
        _pendingGibSpawns: this._pendingGibSpawns,
        _ragdollSystem: this._ragdollSystem,
        _cartoonHit: this._cartoonHit,
        _deathCamera: this._deathCamera,
        onStateUpdateCallbacks: this.onStateUpdateCallbacks,
        get pendingTick() {
          return Game.getInstance().pendingTick;
        },
        set pendingTick(v) {
          Game.getInstance().pendingTick = v;
        },
        get _tabReturnFrameSkips() {
          return Game.getInstance()._tabReturnFrameSkips;
        },
        set _tabReturnFrameSkips(v) {
          Game.getInstance()._tabReturnFrameSkips = v;
        },
        _stateUpdateCount: 0,
        sendRequestSpawn: () => this.sendRequestSpawn(),
      };
    }
    // Update refs that may change
    this._eventCtx.gameHost = this.gameHost;
    this._eventCtx.v2Client = this.v2Client;
    this._eventCtx.isNetworkMode = this.isNetworkMode;
    this._eventCtx._gibSystem = this._gibSystem;
    this._eventCtx._ragdollSystem = this._ragdollSystem;
    this._eventCtx._cartoonHit = this._cartoonHit;
    return this._eventCtx;
  }

  /**
   * Handle state update from simulation — delegates to GameEvents module
   */
  private onServerStateUpdate(state: GameState): void {
    // Store latest state for spectator target provider
    this._latestGameState = state;

    // Update spectator cycling list (if spectating)
    if (this.playerState === "spectator" && this.spectatorCycling) {
      this.spectatorCycling.updateFromGameState(state);

      // Update SpectatorOverlay with target player name
      const targetId = this.spectatorCycling.getTargetEntityId();
      if (targetId && this.spectatorOverlay) {
        this.spectatorOverlay.setSpectatingTarget(this.spectatorCycling.getTargetName());
      }
    }

    // Detect server-confirmed join: our entity appeared in snapshot
    if (this._joinPending && this.localPlayerId) {
      const myPlayer = state.players.get(this.localPlayerId);
      if (myPlayer && myPlayer.entityId && state.entities.has(myPlayer.entityId)) {
        console.log(`[Game] Server confirmed join — entity ${myPlayer.entityId} found in snapshot`);
        this.completeJoinGame();
      }
    }

    // Lazy-init remote renderer if not yet created
    if (!this.remoteRenderer) {
      const cam = CameraSystem.getInstance().getCamera();
      const gameScene = cam?.getScene();
      if (gameScene) {
        this.remoteRenderer = new RemotePlayerRenderer(gameScene);
        this.remoteRenderer.setEnemyWeapons(this.enemyWeapons);
      }
    }
    handleServerStateUpdate(this.getEventContext(), state);
  }

  /**
   * Set spawn points (from map entities)
   */
  setSpawnPoints(points: Array<{ x: number; y: number; z: number }>): void {
    if (this.simulation) {
      this.simulation.setSpawnPoints(points);
    }
  }

  /**
   * Set collision world (from loaded BSP)
   * This sets collision on BOTH the local simulation AND the network prediction simulation
   */
  setCollisionWorld(
    collision: import("../../engine/network/systems/collision/CollisionWorld").CollisionWorld | null,
  ): void {
    // Set on local simulation (for local mode)
    if (this.simulation) {
      this.simulation.setCollisionWorld(collision);
      console.log("[Game] Collision world set on local simulation");
    }

    // Also set on NetworkGameHost's prediction simulation (for network mode)
    const networkHost = this.gameHost as any;
    if (networkHost && typeof networkHost.setCollisionWorld === "function") {
      networkHost.setCollisionWorld(collision);
      console.log("[Game] Collision world set on network prediction simulation");
    }

    // Set on V2NetworkClient for Q3-style prediction (network mode)
    if (this.v2Client) {
      this.v2Client.setCollisionWorld(collision);
      console.log("[Game] Collision world set on V2NetworkClient");
    }
  }
}
