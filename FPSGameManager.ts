/**
 * FPSGameManager - Manages network simulation for FPS game
 *
 * Bridges FPSPlayer/FPSController with the authoritative simulation.
 * In single-player, runs LocalGameHost with FPSSimulation.
 * In multiplayer, uses NetworkGameHost to connect to a dedicated server.
 */

import type { IGameHost } from '../../engine/network/core/IGameHost';
import { LocalGameHost } from '../../engine/network/client/hosts/LocalGameHost';
import { NetworkGameHost } from '../../engine/network/client/hosts/NetworkGameHost';
import { TransportFactory } from '../../engine/network/client/transport/Transport';
import { FPSSimulation, FPSInputCommand } from './simulation/FPSSimulation';
import { InputButtons } from '../../engine/network/components/InputComponent';
import type { GameState } from '../../engine/network/core/GameState';
import type { TransformComponent } from '../../engine/network/components/TransformComponent';
import type { VelocityComponent } from '../../engine/network/components/VelocityComponent';
import { SnapshotBuffer, EntitySnapshot } from '../../engine/network/client/SnapshotBuffer';


import { getCollisionManager } from '../../engine/physics/CollisionManager';
import { createBSPCollisionWorld } from './simulation/collision/BSPCollisionWorld';
import { V2NetworkClient } from './client';
import type { ServerSnapshot } from './client';
import { MatchStateManager } from './client/MatchStateManager';

import { HUDState } from './client/HUDState';
import { FPSHud } from './client/FPSHud';
import { MessageCodec } from '../../engine/network/protocol/MessageCodec';
import { getHitscanEffects } from '../../engine/weapon/HitscanEffects';
import { getProjectileManager } from '../../engine/weapon/ProjectileManager';
import { getWeaponViewManager } from '../../engine/weapon/WeaponViewManager';
import { Vector3, Color3 } from '@babylonjs/core';
import { EngineStore } from '@babylonjs/core/Engines/engineStore';
import { RemotePlayerRenderer } from './client/RemotePlayerRenderer';
import { DroppedWeaponRenderer } from './client/DroppedWeaponRenderer';
import { getExplosionEffect, ROCKET_EXPLOSION, GRENADE_EXPLOSION, PLASMA_EXPLOSION } from '../../engine/weapon/ExplosionEffect';
import { FPSPlayer } from './FPSPlayer';
import { NetGraph } from '../../engine/network/client/NetGraph';
import { InputSystem } from '../../engine/input/InputSystem';
import { CameraSystem } from '../../engine/camera';
import { registerFPSActions } from './client/FPSActions';
import { PlayerProfile } from '../../engine/player/PlayerProfile';

export interface FPSGameConfig {
  tickRate?: number;
  maxPlayers?: number;
  /** When true, auto-join the game after map loads (skip spectator overlay) */
  autoJoin?: boolean;
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
  use: boolean;
  pitch: number;  // Camera X rotation
  yaw: number;    // Camera Y rotation
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
  wallJumpState: 'none' | 'available' | 'charging';
  ledgeGrabState: 'none' | 'grabbing' | 'pulling';
  actualHorizSpeed: number;
  slidePhase: number;
  ledgeGrabPhase: number;
}

export class FPSGameManager {
  private static instance: FPSGameManager | null = null;

  private gameHost: IGameHost | null = null;
  private simulation: FPSSimulation | null = null;
  private localPlayerId: string = '';
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

  // Callbacks
  private onStateUpdateCallbacks: ((state: PlayerStateUpdate) => void)[] = [];

  // Death state tracking (for death camera)
  private _isPlayerDead: boolean = false;

  // Spectator state
  private playerState: 'spectator' | 'playing' = 'spectator';
  private spectatorOverlay: import('./client/SpectatorOverlay').SpectatorOverlay | null = null;
  private _joinKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _scoreboardKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _scoreboardKeyUpHandler: ((e: KeyboardEvent) => void) | null = null;

  private pendingTick: number = 0;

  // Cached effect system singletons (lazy-resolved, avoids per-frame import())
  private _gibSystem: any = null;
  private _gibSystemLoading = false;  // true while import() is pending
  private _pendingGibSpawns: { x: number; y: number; z: number; vx: number; vy: number; vz: number }[] = [];
  private _damageNumbers: any = null;
  private _ragdollSystem: any = null;
  private _ragdollSystemLoading = false;
  private _cartoonHit: any = null;
  private _cartoonHitLoading = false;

  private constructor() {
    // Register all FPS actions + contexts with InputSystem
    registerFPSActions();
  }

  static getInstance(): FPSGameManager {
    if (!FPSGameManager.instance) {
      FPSGameManager.instance = new FPSGameManager();
    }
    return FPSGameManager.instance;
  }

  /**
   * Initialize local game (single-player mode)
   */
  async initializeLocal(config: FPSGameConfig = {}): Promise<void> {
    // Guard against multiple initializations
    if (this.isRunning) {
      console.warn('[FPSGameManager] Already initialized, skipping');
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

    const tickRate = config.tickRate ?? 125;  // Must match server tick rate (125Hz)
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

        console.log(`[FPSGameManager] Server map: ${serverInfo.map}`);

        // Load the server's map via console command
        try {
          const { CommandRegistry } = await import('../../engine/console/CommandRegistry');
          const registry = CommandRegistry.getInstance();
          const result = await registry.execute(`map ${serverInfo.map}`);


          // Check if map load failed
          if (typeof result === 'string' && result.includes('Failed')) {
            console.error(`[FPSGameManager] Map load failed, disconnecting...`);
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
                console.warn(`[FPSGameManager] BSP collision world could not be created - backend not available`);
              }
            } else {
              console.warn(`[FPSGameManager] CollisionManager NOT initialized - client prediction will NOT have BSP collision!`);
            }

            const { CameraSystem } = await import('../../engine/camera/CameraSystem');
            const { FPSController } = await import('../../engine/camera/controllers/FPSController');
            const { FreeflyController } = await import('../../engine/camera/controllers/FreeflyController');
            const cameraSystem = CameraSystem.getInstance();

            // Register FPS controller (but don't activate — player starts as spectator)
            if (!cameraSystem.getController('fps')) {
              cameraSystem.registerController('fps', new FPSController());
            }

            // Register and activate freefly controller for spectator mode
            if (!cameraSystem.getController('freefly')) {
              cameraSystem.registerController('freefly', new FreeflyController());
            }
            // Start in freefly mode (spectator default)
            cameraSystem.setController('freefly');

            // Auto-join if requested (lobby flow — skip spectator overlay)
            if (config.autoJoin) {
              console.log('[FPSGameManager] Auto-joining game (lobby flow)');
              // Small delay to ensure everything is settled
              setTimeout(() => this.joinGame(), 200);
            }
          } catch (e) {
            console.warn(`[FPSGameManager] Could not set up FPS controller after map load:`, e);
          }
        } catch (error) {
          console.error(`[FPSGameManager] Failed to load map ${serverInfo.map}:`, error);
          console.log(`[FPSGameManager] Disconnecting due to map load error...`);
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

      // Load player profile and connect with display name
      const profile = PlayerProfile.load();
      console.log(`[FPSGameManager] Connecting as "${profile.name}" (id: ${profile.id.substring(0, 8)}...)`);

      // Connect to server (this triggers onServerInfo callback which loads map and sets collision)
      await networkHost.connect(url, profile.name);

      // Update player ID after connect (server assigns it during handshake)
      this.localPlayerId = networkHost.localPlayerId;
      this.simulation = null; // No direct simulation access in network mode





      // Initialize FPSHud (Washiki HUD system)
      const fpsHud = FPSHud.getInstance();
      await fpsHud.init();
      fpsHud.start();

      // Initialize NetGraph overlay (cl_netgraph CVar)
      NetGraph.init();

      // ── Spectator Mode: show join overlay on connect ──────────
      this.playerState = 'spectator';

      // Only show spectator overlay if NOT auto-joining
      if (!config.autoJoin) {
        const { SpectatorOverlay } = await import('./client/SpectatorOverlay');
        this.spectatorOverlay = new SpectatorOverlay();
        this.spectatorOverlay.setMode('join-overlay');

        this.spectatorOverlay.onJoinGame(() => {
          this.joinGame();
        });
        this.spectatorOverlay.onSpectate(() => {
          // Switch to freefly spectator (no entity, just camera)
          this.spectatorOverlay?.setMode('freefly');
          this.switchToFreeflyCamera();
        });
      } // end if (!config.autoJoin)

      // ── J key shortcut to join game from spectator mode ──
      // Uses InputSystem's raw key state (this runs in an event handler, not per-frame)
      this._joinKeyHandler = (_e: KeyboardEvent) => {
        const input = InputSystem.getInstance();
        if (input.isKeyDown('KeyJ') && this.playerState === 'spectator') {
          this.joinGame();
        }
      };
      document.addEventListener('keydown', this._joinKeyHandler);

      // ── Tab key: hold-to-show scoreboard (Quake style) ──
      this._scoreboardKeyHandler = (e: KeyboardEvent) => {
        if (e.code === 'Tab') {
          e.preventDefault();
          const hud = FPSHud.getInstance();
          hud.scoreboard?.show();
        }
      };
      this._scoreboardKeyUpHandler = (e: KeyboardEvent) => {
        if (e.code === 'Tab') {
          e.preventDefault();
          const hud = FPSHud.getInstance();
          hud.scoreboard?.hide();
        }
      };
      document.addEventListener('keydown', this._scoreboardKeyHandler);
      document.addEventListener('keyup', this._scoreboardKeyUpHandler);

    } catch (error) {
      console.error(`[FPSGameManager] Failed to connect to ${url}:`, error);
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
    return this._lastServerWeapon || 'gunblade';
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
    return this.playerState === 'spectator';
  }

  /**
   * Get current player state
   */
  getPlayerState(): 'spectator' | 'playing' {
    return this.playerState;
  }

  // ========================================================================
  // Spectator Mode
  // ========================================================================

  /**
   * joinGame — transition from spectator to playing.
   * Sends JoinGame to server, switches camera to FPS, hides overlay.
   */
  async joinGame(): Promise<void> {
    if (this.playerState === 'playing') return;
    if (!this.gameHost || !this.isNetworkMode) return;

    const networkHost = this.gameHost as import('../../engine/network/client/hosts/NetworkGameHost').NetworkGameHost;

    // Tell server to create our entity
    networkHost.sendJoinGame();

    // Switch to FPS camera controller
    try {
      const { CameraSystem } = await import('../../engine/camera/CameraSystem');
      const { FPSController } = await import('../../engine/camera/controllers/FPSController');
      const cameraSystem = CameraSystem.getInstance();

      if (!cameraSystem.getController('fps')) {
        cameraSystem.registerController('fps', new FPSController());
      }
      cameraSystem.setController('fps');

      // Enable network mode on FPS controller
      const controller = cameraSystem.getActiveController();
      if (controller && controller.type === 'fps' && typeof (controller as any).enableNetworkMode === 'function') {
        (controller as any).enableNetworkMode();
      }
    } catch (e) {
      console.warn('[FPSGameManager] Could not switch to FPS camera:', e);
    }

    // Update state
    this.playerState = 'playing';
    this.spectatorOverlay?.setMode('hidden');

    // Initialize weapon view manager with the now-active FPS camera
    try {
      const { CameraSystem } = await import('../../engine/camera/CameraSystem');
      const { getWeaponViewManager } = await import('../../engine/weapon/WeaponViewManager');
      const { getProjectileManager } = await import('../../engine/weapon/ProjectileManager');
      const { initializeEntityDefs } = await import('../../shared/entities');
      const { FreeCamera } = await import('@babylonjs/core/Cameras/freeCamera');

      const camera = CameraSystem.getInstance().getCamera();
      const scene = camera?.getScene();

      if (scene && camera instanceof FreeCamera) {
        initializeEntityDefs();
        const wvm = getWeaponViewManager();
        wvm.init(scene, camera);
        wvm.loadWeapon('gunblade', 'data/data0_21pure.pk3').then(async success => {
          if (success) {
            console.log('[FPSGameManager] Weapon loaded for join');
            const projMgr = getProjectileManager();
            await Promise.all([
              projMgr.preloadModel('plasma_bolt'),
              projMgr.preloadModel('grenade'),
              projMgr.preloadModel('rocket'),
              projMgr.preloadModel('gunblade_blast'),
            ]);
          }
        });
      }
    } catch (e) {
      console.warn('[FPSGameManager] Failed to init weapon view:', e);
    }

    // Request pointer lock for FPS controls
    const canvas = document.querySelector('canvas');
    if (canvas) {
      canvas.requestPointerLock();
    }

    console.log('[FPSGameManager] Joined game');
  }

  /**
   * goSpectator — transition from playing to spectator.
   * Sends Spectate to server, switches camera to freefly, shows overlay.
   */
  async goSpectator(): Promise<void> {
    if (this.playerState === 'spectator') return;
    if (!this.gameHost || !this.isNetworkMode) return;

    const networkHost = this.gameHost as import('../../engine/network/client/hosts/NetworkGameHost').NetworkGameHost;

    // Tell server to remove our entity
    networkHost.sendSpectate();

    // Switch to freefly camera
    this.switchToFreeflyCamera();

    // Update state
    this.playerState = 'spectator';
    this.spectatorOverlay?.setMode('freefly');

    // Hide weapon view model
    import('../../engine/weapon/WeaponViewManager').then(m => {
      m.getWeaponViewManager().setVisible(false);
    });

    // Hide speedometer (prevent overlap with spectator overlay)
    const speedEl = document.getElementById('fps-speed-display');
    if (speedEl) speedEl.remove();
    // Reset static refs so a fresh widget is created on rejoin
    (await import('../../engine/camera/controllers/FPSController')).FPSController.resetSpeedDisplay?.();

    // Release pointer lock
    document.exitPointerLock();

    console.log('[FPSGameManager] Now spectating');
  }

  /**
   * Switch the active camera to freefly controller (for spectator mode).
   */
  private async switchToFreeflyCamera(): Promise<void> {
    try {
      const { CameraSystem } = await import('../../engine/camera/CameraSystem');
      const { FreeflyController } = await import('../../engine/camera/controllers/FreeflyController');
      const cameraSystem = CameraSystem.getInstance();

      if (!cameraSystem.getController('freefly')) {
        cameraSystem.registerController('freefly', new FreeflyController());
      }
      cameraSystem.setController('freefly');

      console.log('[FPSGameManager] Switched to freefly camera');
    } catch (e) {
      console.warn('[FPSGameManager] Could not switch to freefly camera:', e);
    }
  }

  /**
   * Spawn local player in simulation
   * @param spawnPosition Optional spawn position (uses random spawn point if not provided)
   */
  spawnLocalPlayer(spawnPosition?: { x: number; y: number; z: number }): void {
    if (!this.simulation) {
      console.error('[FPSGameManager] Cannot spawn - not initialized');
      return;
    }

    // Spawn player in simulation
    const entity = this.simulation.spawnPlayer(this.localPlayerId);

    // Override spawn position if provided
    if (spawnPosition) {
      const transform = entity.getComponent<TransformComponent>('transform');
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
    if (this.playerState === 'spectator') {
      return;
    }

    // While dead, strip ALL gameplay input — no movement, jumping, or firing
    if (this._isPlayerDead) {
      input.forward = false;
      input.backward = false;
      input.left = false;
      input.right = false;
      input.jump = false;
      input.crouch = false;
      input.sprint = false;
      input.fire = false;
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
    if (input.forward) { dirX += forwardX; dirZ += forwardZ; }
    if (input.backward) { dirX -= forwardX; dirZ -= forwardZ; }
    if (input.left) { dirX -= rightX; dirZ -= rightZ; }
    if (input.right) { dirX += rightX; dirZ += rightZ; }

    // Normalize the final direction
    const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (dirLen > 0) {
      dirX /= dirLen;
      dirZ /= dirLen;
    }

    // Create input command
    const cmd: FPSInputCommand = {
      type: 'fps_input',
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
    const dtSec = (EngineStore.LastCreatedEngine?.getDeltaTime() ?? 16) / 1000;

    // Update gib physics (gravity, bouncing, tumble, fade)
    if (!this._gibSystem && !this._gibSystemLoading) {
      // Eagerly init on first frame so it's ready for death events
      this._gibSystemLoading = true;
      import('./client/GibSystem').then(m => {
        const gibs = m.GibSystem.getInstance();
        const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
        if (gameScene) {
          gibs.init(gameScene); // init() handles scene changes gracefully
        }
        if (gibs['scene']) {
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
      }).catch(e => {
        console.error('[GibSystem] Failed to load GibSystem module:', e);
        this._gibSystemLoading = false;
      });
    } else if (this._gibSystem) {
      this._gibSystem.update(dtSec);
    }

    // Update ragdoll physics (Havok-driven skeleton ragdolls)
    if (!this._ragdollSystem && !this._ragdollSystemLoading) {
      this._ragdollSystemLoading = true;
      import('./client/RagdollSystem').then(m => {
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
          console.log('[RagdollSystem] Initialized');
        } else {
          console.log('[RagdollSystem] Scene not ready, will retry');
          this._ragdollSystemLoading = false;
        }
      }).catch(e => {
        console.error('[RagdollSystem] Failed to load:', e);
        this._ragdollSystemLoading = false;
      });
    } else if (this._ragdollSystem) {
      this._ragdollSystem.update(dtSec);
    }

    // Update floating damage numbers (float upward, fade out)
    if (this._damageNumbers) {
      this._damageNumbers.update(dtSec);
    } else {
      import('./client/DamageNumbers').then(m => {
        const dn = m.DamageNumbers.getInstance();
        if (dn['scene']) this._damageNumbers = dn;
      });
    }

    // Update cartoon hit effects (Warsow-style POW! sprites)
    if (!this._cartoonHit && !this._cartoonHitLoading) {
      this._cartoonHitLoading = true;
      import('./client/CartoonHitEffect').then(m => {
        const ch = m.CartoonHitEffect.getInstance();
        const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
        if (gameScene) {
          ch.init(gameScene);
          this._cartoonHit = ch;
          console.log('[CartoonHitEffect] Initialized');
        } else {
          this._cartoonHitLoading = false;
        }
      }).catch(e => {
        console.error('[CartoonHitEffect] Failed to load:', e);
        this._cartoonHitLoading = false;
      });
    } else if (this._cartoonHit) {
      this._cartoonHit.update(dtSec);
    }

    // Render network diagnostics overlay (if cl_netgraph > 0)
    NetGraph.render();
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
        new Vector3(interp.vx, interp.vy, interp.vz)
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
        return null;  // Camera will wait for valid position
      }
      // Decay the visual smoothing offset each frame (absorbs reconciliation jitter)
      const engine = EngineStore.LastCreatedEngine;
      const dt = engine ? engine.getDeltaTime() / 1000 : 0.016;
      this.v2Client.decayVisualOffset(dt);
      // Use visually smoothed position for camera rendering
      const pos = this.v2Client.getVisualPosition();
      return { x: pos.x, y: pos.y, z: pos.z };
    }

    const state = this.gameHost.getLocalState();
    const player = state.players.get(this.localPlayerId);
    if (!player) {
      if (Math.random() < 0.01) {
        console.log(`[FPSGameManager] getLocalPlayerPosition: no player for ${this.localPlayerId}`);
      }
      return null;
    }

    // For NetworkGameHost (legacy path without V2Client), use interpolated entity
    const networkHost = this.gameHost as any;
    if (typeof networkHost.getInterpolatedEntity === 'function') {
      const interpolatedEntity = networkHost.getInterpolatedEntity(player.entityId);
      if (interpolatedEntity) {
        const transform = interpolatedEntity.getComponent('transform') as any;
        if (transform?.position) {
          return {
            x: transform.position.x,
            y: transform.position.y,
            z: transform.position.z
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

    const transform = entity.getComponent<TransformComponent>('transform');
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
      console.log('[FPSGameManager] Cannot send ready — not connected');
      return;
    }

    const data = MessageCodec.encodeReady();
    // Send via the NetworkGameHost's transport
    const networkHost = this.gameHost as any;
    if (networkHost.transport && typeof networkHost.transport.send === 'function') {
      networkHost.transport.send(data, true); // Reliable
      MatchStateManager.getInstance().setReady(true);
      console.log('[FPSGameManager] Sent ready signal to server');
    }
  }

  /**
   * Shutdown game
   */
  shutdown(): void {
    if (this.gameHost) {
      // Disconnect if in network mode
      if (this.isNetworkMode && 'disconnect' in this.gameHost) {
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

    // Cleanup event listeners
    if (this._joinKeyHandler) {
      document.removeEventListener('keydown', this._joinKeyHandler);
      this._joinKeyHandler = null;
    }
    if (this._scoreboardKeyHandler) {
      document.removeEventListener('keydown', this._scoreboardKeyHandler);
      this._scoreboardKeyHandler = null;
    }
    if (this._scoreboardKeyUpHandler) {
      document.removeEventListener('keyup', this._scoreboardKeyUpHandler);
      this._scoreboardKeyUpHandler = null;
    }

    // Cleanup match state and HUD

    FPSHud.getInstance().destroy();
    MatchStateManager.destroy();
    HUDState.destroy();

    console.log('[FPSGameManager] Shutdown complete');
  }

  // Diagnostic counter for onServerStateUpdate
  private _stateUpdateCount = 0;

  /**
   * Handle state update from simulation
   */
  private onServerStateUpdate(state: GameState): void {
    this._stateUpdateCount++;

    // Record snapshot for NetGraph
    const localPlayer = state.players.get(this.localPlayerId);
    NetGraph.recordSnapshot(localPlayer?.ping ?? 0, state.tick);

    // Feed ClockSync offset to NetGraph for display
    const networkHost = this.gameHost as any;
    if (networkHost?.clockSync?.isSynced()) {
      NetGraph.setClockOffset(networkHost.clockSync.getOffset());
    }

    // Dynamically sync localPlayerId from the game host.
    // JoinAccept sets networkHost.localPlayerId DURING connect(), but
    // FPSGameManager.localPlayerId is only copied AFTER connect() resolves.
    // This ensures we pick up the server-assigned ID as soon as JoinAccept arrives.
    if (this.gameHost && this.localPlayerId !== this.gameHost.localPlayerId) {
      this.localPlayerId = this.gameHost.localPlayerId;
    }

    // === DIAGNOSTIC: Log first few calls ===
    if (this._stateUpdateCount <= 3) {
      // Auto-enable HUD debug overlay on first update (disabled — using FPSHud now)
      if (this._stateUpdateCount === 1) {
        // HUDState.getInstance().setDebug(true);
      }
    }

    // Process match_state events before anything else
    const localEntityId = state.players.get(this.localPlayerId)?.entityId;

    if (state.events && state.events.length > 0) {
      const matchMgr = MatchStateManager.getInstance();

      for (const event of state.events) {
        if (event.type === 'match_state') {
          matchMgr.processEvent(event);
        } else if (event.type === 'weapon_state' && event.entityId === localEntityId) {
          // Sync local player weapon from server
          this.handleWeaponStateSync(event);
        } else if (event.type === 'weapon_state' && event.entityId !== localEntityId) {
          // Track enemy weapon for third-person rendering
          if (event.currentWeapon) {
            this.enemyWeapons.set(event.entityId, event.currentWeapon);
          }
        } else if (event.type === 'weapon_fire') {
          if (event.entityId === localEntityId) {
            // Server confirmed our fire — trigger local muzzle flash, recoil, and hitscan effects
            const wvm = getWeaponViewManager();
            wvm.fire();
          } else {
            this.handleRemoteWeaponFire(event);
          }
        } else if (event.type === 'projectile_impact') {
          // Server-authoritative explosion — deduplicate against client-predicted explosions
          const pos = new Vector3(event.x, event.y, event.z);
          const projDefId = event.defId === 'glauncher' ? 'grenade'
            : event.defId === 'plasmagun' ? 'plasma_bolt'
              : event.defId === 'rlauncher' ? 'rocket'
                : event.defId;

          // Check if client already predicted this explosion (same position + defId within tolerance)
          if (getProjectileManager().hasRecentPrediction(pos, projDefId)) {
            // Already shown client-side — skip duplicate
            continue;
          }

          const normal = new Vector3(event.normalX, event.normalY, event.normalZ);
          const config = event.defId === 'glauncher' ? GRENADE_EXPLOSION
            : event.defId === 'plasmagun' ? PLASMA_EXPLOSION
              : ROCKET_EXPLOSION;
          getExplosionEffect().spawn(pos, config, normal);
        } else if (event.type === 'item_pickup') {
          // Server confirms a pickup — deactivate the client-side Pickup visual
          import('../../engine/game/Pickup').then(({ Pickup }) => {
            Pickup.deactivateByPosition(event.weaponId, event.x, event.y, event.z);
          });
        } else if (event.type === 'projectile_spawn') {
          // Server tells us about a new projectile entity — record defId mapping
          this.serverProjectileDefIds.set(event.entityId, event.defId);
        } else if (event.type === 'combat_state' && event.entityId === localEntityId) {
          // Combat state for local player (health/armor)
          HUDState.getInstance().processCombatState(event);
          // Track death state for death camera
          if (event.dead && !this._isPlayerDead) {
            this._isPlayerDead = true;
            console.log('[FPSGameManager] Local player died');
            // Hide weapon view model on death
            import('../../engine/weapon/WeaponViewManager').then(m => {
              m.getWeaponViewManager().setVisible(false);
            });
          } else if (!event.dead && this._isPlayerDead) {
            this._isPlayerDead = false;
            console.log('[FPSGameManager] Local player respawned');
            // Show weapon on respawn
            import('../../engine/weapon/WeaponViewManager').then(m => {
              m.getWeaponViewManager().setVisible(true);
            });
          }
        } else if (event.type === 'damage') {
          // Damage event (floating damage numbers)
          HUDState.getInstance().processDamage(event);
          // Hit confirmation: flash crosshair when LOCAL player deals damage
          if (event.attackerId && event.attackerId === localEntityId) {
            import('./client/Crosshair').then(m => m.Crosshair.getInstance().notifyHit());
            // Spawn floating damage number at victim position
            if (event.x !== undefined && event.damage > 0) {
              import('./client/DamageNumbers').then(m => {
                const dn = m.DamageNumbers.getInstance();
                if (!dn['scene']) {
                  const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
                  if (gameScene) dn.init(gameScene);
                }
                dn.spawn(event.x, event.y, event.z, event.damage);
              });
            }
            // Cartoon hit effect (Warsow POW!) on hard hits
            if (event.x !== undefined && this._cartoonHit) {
              this._cartoonHit.spawn(event.x, event.y, event.z, event.damage);
            }
          }
        } else if (event.type === 'death') {
          console.log(`[Death] Event received: entity=${event.entityId} killer=${event.killerId} damageType=${event.damageType} finalDamage=${event.finalDamage} pos=(${event.x}, ${event.y}, ${event.z})`);
          // Death event (kill feed)
          try {
            HUDState.getInstance().processDeath(event);
          } catch (e) {
            console.error('[Death] HUD processDeath error:', e);
          }

          // === GIB vs RAGDOLL DECISION ===
          // Rail (EB) → always gibs
          // Explosion with finalDamage >= 50 → gibs
          // Everything else → ragdoll
          const damageType = event.damageType || event.weaponId || '';
          const finalDamage = event.finalDamage || 0;
          const shouldGib = damageType === 'rail'
            || (damageType === 'explosion' && finalDamage >= 50);

          if (shouldGib) {
            // === GIB DEATH: dispose model + spawn gib particles ===
            try {
              if (this.remoteRenderer && event.entityId) {
                this.remoteRenderer.markDead(event.entityId);
              }
            } catch (e) {
              console.error('[Death] markDead error:', e);
            }
            if (event.x !== undefined) {
              console.log(`[GibSystem] Gib death: dmgType=${damageType} dmg=${finalDamage}`);
              if (this._gibSystem) {
                this._gibSystem.spawn(
                  event.x, event.y, event.z,
                  event.velX || 0, event.velY || 0, event.velZ || 0,
                );
              } else {
                this._pendingGibSpawns.push({
                  x: event.x, y: event.y, z: event.z,
                  vx: event.velX || 0, vy: event.velY || 0, vz: event.velZ || 0,
                });
              }
            }
          } else {
            // === RAGDOLL DEATH: detach model + start physics ===
            console.log(`[RagdollSystem] Ragdoll death: dmgType=${damageType} dmg=${finalDamage}`);
            let model = null;
            try {
              if (this.remoteRenderer && event.entityId) {
                model = this.remoteRenderer.detachModel(event.entityId);
              }
            } catch (e) {
              console.error('[Death] detachModel error:', e);
            }

            if (model && this._ragdollSystem) {
              // Use server-provided knockback direction (from damage source)
              this._ragdollSystem.spawn(
                model,
                event.kbDirX || 0,
                event.kbDirY || 0,
                event.kbDirZ || 0,
              );
            } else if (model) {
              // RagdollSystem not ready — fall back to gibs
              console.warn('[Death] RagdollSystem not ready, falling back to gibs');
              // Dispose the detached model manually
              if (model.mesh) model.mesh.dispose();
              if (model.skeleton) model.skeleton.dispose();
              if (model.anchor) model.anchor.dispose();
              if (event.x !== undefined && this._gibSystem) {
                this._gibSystem.spawn(
                  event.x, event.y, event.z,
                  event.velX || 0, event.velY || 0, event.velZ || 0,
                );
              }
            } else {
              // No model available (might be local player) — just mark dead
              try {
                if (this.remoteRenderer && event.entityId) {
                  this.remoteRenderer.markDead(event.entityId);
                }
              } catch (e) { /* noop */ }
            }
          }
        } else if (event.type === 'weapon_drop') {
          // Spawn dropped weapon visual with Havok physics
          const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
          if (!this.droppedWeaponRenderer && gameScene) {
            this.droppedWeaponRenderer = new DroppedWeaponRenderer(gameScene);
          }
          if (this.droppedWeaponRenderer) {
            const pos = new Vector3(event.x, event.y, event.z);
            const vel = new Vector3(event.velX || 0, event.velY || 0, event.velZ || 0);
            this.droppedWeaponRenderer.spawn(event.entityId, event.weaponId, pos, vel);
          }
        }
      }
    }

    // Update HUD state aggregator
    const hudState = HUDState.getInstance();
    hudState.localPlayerId = this.localPlayerId;
    hudState.updateScoreboard(state);
    hudState.expireTransients();
    hudState.updateDebugOverlay();

    // === Remote player snapshot buffering (push only — rendering is per-frame) ===
    // Always init renderer (spectators need to see other players/bots too)
    {
      // Lazy-init renderer with the GAMEPLAY scene (NOT EngineStore.LastCreatedScene
      // which may point to LogoCanvas or other UI scenes!)
      if (!this.remoteRenderer) {
        const cam = CameraSystem.getInstance().getCamera();
        const gameScene = cam?.getScene();
        if (gameScene) {
          this.remoteRenderer = new RemotePlayerRenderer(gameScene);
        }
      }
      if (this.remoteRenderer) {
        // Convert server timestamp to local time via ClockSync for accurate interpolation
        let serverLocalTime: number | undefined;
        const networkHost = this.gameHost as any;
        if (state.serverTimestamp && networkHost?.clockSync?.isSynced()) {
          serverLocalTime = networkHost.clockSync.toLocalTime(state.serverTimestamp);
        }

        // Pass localEntityId (empty string for spectators — no entity excluded)
        this.remoteRenderer.pushSnapshot(state, localEntityId || '', serverLocalTime);
      }
    }

    // === Dropped weapon entity sync (position convergence + cleanup) ===
    if (this.droppedWeaponRenderer) {
      const itemPositions = new Map<string, { x: number; y: number; z: number }>();
      for (const [id, entity] of state.entities) {
        if (id.startsWith('item_')) {
          const t = entity.getComponent('transform') as any;
          if (t?.position) {
            itemPositions.set(id, { x: t.position.x, y: t.position.y, z: t.position.z });
          }
        }
      }
      this.droppedWeaponRenderer.syncServerEntities(itemPositions);
    }

    // === Server-driven projectile entity processing (Q3-style) ===
    // Push proj_ entities into SnapshotBuffer for smooth interpolation
    {
      const projEntities = new Map<string, EntitySnapshot>();
      const aliveThisSnapshot = new Set<string>();

      for (const [entityId, entity] of state.entities) {
        if (!entityId.startsWith('proj_')) continue;
        aliveThisSnapshot.add(entityId);

        const posComp = entity.getComponent('position') as any;
        const velComp = entity.getComponent('velocity') as any;
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
        });

        // Spawn visual if this is a new projectile
        if (!this.activeServerProjectiles.has(entityId)) {
          const defId = this.serverProjectileDefIds.get(entityId);
          if (defId) {
            const projMgr = getProjectileManager();
            if (!projMgr['scene']) {
              const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
              if (gameScene) projMgr.init(gameScene);
            }
            const pos = new Vector3(posComp.x, posComp.y, posComp.z);
            const vel = velComp
              ? new Vector3(velComp.x, velComp.y, velComp.z)
              : Vector3.Zero();
            projMgr.spawnFromServer(entityId, defId, pos, vel);
            this.activeServerProjectiles.add(entityId);
          }
        }
      }

      // Push to interpolation buffer (using same ClockSync timing as remote players)
      let serverLocalTime: number | undefined;
      const networkHost = this.gameHost as any;
      if (state.serverTimestamp && networkHost?.clockSync?.isSynced()) {
        serverLocalTime = networkHost.clockSync.toLocalTime(state.serverTimestamp);
      }
      this.projectileBuffer.push(state.tick, projEntities, serverLocalTime);

      // Despawn visuals for projectiles that disappeared from snapshot
      for (const entityId of this.activeServerProjectiles) {
        if (!aliveThisSnapshot.has(entityId)) {
          getProjectileManager().despawnByEntityId(entityId);
          this.activeServerProjectiles.delete(entityId);
          this.serverProjectileDefIds.delete(entityId);
        }
      }
    }

    const player = state.players.get(this.localPlayerId);
    if (!player) {
      if (this._stateUpdateCount <= 5 || this._stateUpdateCount % 500 === 0) {
        console.warn(`[FPSGameManager] onServerStateUpdate #${this._stateUpdateCount}: NO PLAYER for '${this.localPlayerId}'. Player keys: [${[...state.players.keys()].join(',')}]`);
      }
      return;
    }

    const entity = state.entities.get(player.entityId);
    if (!entity) {
      if (this._stateUpdateCount <= 5 || this._stateUpdateCount % 500 === 0) {
        console.warn(`[FPSGameManager] onServerStateUpdate #${this._stateUpdateCount}: NO ENTITY for '${player.entityId}'. Entity keys: [${[...state.entities.keys()].join(',')}]`);
      }
      return;
    }

    const transform = entity.getComponent<TransformComponent>('transform');
    const velocity = entity.getComponent<VelocityComponent>('velocity');

    if (!transform || !velocity) {
      if (this._stateUpdateCount <= 5) {
        console.warn(`[FPSGameManager] onServerStateUpdate #${this._stateUpdateCount}: MISSING COMPONENTS transform=${!!transform} velocity=${!!velocity}`);
      }
      return;
    }

    // Movement state fields are stored on the physics/velocity component by the server
    // (FPSMovementSubsystem.applyResult writes isSliding, isCrouching, etc. to entity.physics)
    const physics = velocity as any;


    // === V2 CLIENT: Buffer snapshot for frame-synchronized processing ===
    if (this.v2Client && this.isNetworkMode) {
      const snapshot: ServerSnapshot = {
        tick: state.tick,
        ackedInputSeq: state.ackedInputSeq,
        position: { ...transform.position },
        velocity: { ...velocity.linear },
        grounded: velocity.grounded,
      };
      // Buffer snapshot — will be processed during processSnapshots() in frame loop
      this.v2Client.bufferSnapshot(snapshot);



      // Movement state (crouchslide, walljump, etc.) comes from client prediction
      // via v2Client.getMovementState() - no wire protocol needed.
      this.pendingTick = state.tick;
      return;
    }

    const update: PlayerStateUpdate = {
      position: { ...transform.position },
      velocity: { ...velocity.linear },
      grounded: velocity.grounded,
      tick: state.tick,
      // Advanced movement state
      isSliding: physics.isSliding ?? false,
      isCrouching: physics.isCrouching ?? false,
      crouchViewOffset: physics.crouchViewOffset ?? 0,
      wallJumpState: physics.wallJumpState ?? 'none',
      ledgeGrabState: physics.ledgeGrabState ?? 'none',
      actualHorizSpeed: physics.actualHorizSpeed ?? 0,
      slidePhase: physics.slidePhase ?? 0,
      ledgeGrabPhase: physics.ledgeGrabPhase ?? 0,
    };

    // Notify callbacks
    for (const callback of this.onStateUpdateCallbacks) {
      callback(update);
    }
  }

  // ── Server weapon state sync ──────────────────────────────────

  /**
   * Handle weapon_state event from server for the local player.
   * Syncs the client's inventory and weapon view with server state.
   */
  private handleWeaponStateSync(event: any): void {
    const player = FPSPlayer.getInstance();
    if (!player) return;

    // Server is authoritative — always sync weapon state regardless of death flag.
    // Weapon VIEW visibility is controlled separately by combat_state death/respawn events.

    const serverWeapon = event.currentWeapon as string;
    const serverWeapons = event.weapons as string[];
    const serverAmmo = event.ammo as Record<string, number>;

    // Authoritative sync: add/remove weapons, sync ammo, equip server's weapon
    player.inventory.syncFromServer(serverWeapons, serverAmmo, serverWeapon);

    // Sync reload state from server — prevents ghost shots during server reload
    if (event.reloading !== undefined) {
      player.setServerReloadState(event.reloading as boolean);
    }
    // Sync fire timing from server tick to prevent client firing ahead of server cooldown
    if (event.lastFireTick !== undefined) {
      player.syncFireTiming(event.lastFireTick as number);
    }

    // Keep FPSController's currentWeaponSlot in sync with server (every tick).
    // This ensures mouse scroll cycling and key switching reference the correct slot.
    const slotIndex = serverWeapons.indexOf(serverWeapon);
    if (slotIndex >= 0) {
      player.getController().currentWeaponSlot = slotIndex;
    }

    // Update HUD with weapon state
    const hudState = HUDState.getInstance();
    hudState.processWeaponState({
      currentWeapon: serverWeapon,
      weapons: serverWeapons,
      ammo: serverAmmo,
    });

    // Detect weapon change using _lastServerWeapon (reliable, one source of truth)
    if (serverWeapon !== this._lastServerWeapon) {
      const isFirstWeapon = this._lastServerWeapon === undefined;
      console.log(`[FPSGameManager] Server weapon changed: ${this._lastServerWeapon || 'none'} → ${serverWeapon}`);
      this._lastServerWeapon = serverWeapon;

      const wvm = getWeaponViewManager();
      if (isFirstWeapon) {
        // First weapon (initial spawn) — load directly without animation
        wvm.loadWeapon(serverWeapon).catch(err => {
          console.error(`[FPSGameManager] Failed to load initial weapon: ${serverWeapon}`, err);
        });
      } else {
        // Subsequent changes — play switch animation (slide-down → load → slide-up)
        wvm.switchWeaponAnimated(serverWeapon).catch(err => {
          console.error(`[FPSGameManager] Failed to switch weapon: ${serverWeapon}`, err);
        });
      }
    }
  }

  // ── Remote weapon fire effects ──────────────────────────────────

  /** Color palette per weapon ID (Warsow-inspired) */
  private static WEAPON_EFFECT_COLORS: Record<string, [number, number, number]> = {
    machinegun: [1.0, 0.9, 0.3],   // warm yellow
    riotgun: [1.0, 0.6, 0.2],   // orange
    lasergun: [0.2, 1.0, 0.4],   // green
    electrobolt: [0.3, 0.6, 1.0],   // blue
    instagun: [0.8, 0.2, 1.0],   // purple
  };

  /**
   * Spawn visual effects for another player's weapon fire.
   * Called when we receive a weapon_fire event for a remote player.
   */
  private handleRemoteWeaponFire(event: any): void {
    const fx = getHitscanEffects();
    const projMgr = getProjectileManager();

    // Lazy-init ProjectileManager if it hasn't been initialized yet
    // (WeaponViewManager.init normally does this, but may not have run)
    if (!projMgr['scene']) {
      const gameScene = CameraSystem.getInstance().getCamera()?.getScene();
      if (gameScene) projMgr.init(gameScene);
    }

    const origin = new Vector3(event.originX, event.originY, event.originZ);
    const dir = new Vector3(event.dirX, event.dirY, event.dirZ);
    const rgb = FPSGameManager.WEAPON_EFFECT_COLORS[event.weaponId];
    const color = rgb ? new Color3(rgb[0], rgb[1], rgb[2]) : new Color3(1, 1, 0.5);

    switch (event.weaponId) {
      case 'machinegun':
        fx.fireTracer({ origin, direction: dir, color, maxRange: 6000 });
        break;

      case 'riotgun':
        fx.firePellets({
          origin, direction: dir, color,
          pelletCount: 20,
          spreadAngle: 12,
          maxRange: 8192,
        });
        break;

      case 'lasergun':
        // Beam weapons update continuously — for now just spawn a tracer
        // Full beam sync will come in Phase 1b (weapon_stop events)
        fx.fireTracer({ origin, direction: dir, color, maxRange: 850 });
        break;

      case 'electrobolt':
      case 'instagun':
        fx.fireBolt({ origin, direction: dir, color, maxRange: 10000 });
        break;

      // Projectile weapons — visuals now come from server entities (Q3-style)
      // No need to spawn client-side predictions here
      case 'plasmagun':
      case 'rlauncher':
      case 'glauncher':
      case 'gunblade':
        break;

      default:
        fx.fireTracer({ origin, direction: dir, color, maxRange: 5000 });
        break;
    }
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
  setCollisionWorld(collision: import('../../engine/network/systems/collision/CollisionWorld').CollisionWorld | null): void {
    // Set on local simulation (for local mode)
    if (this.simulation) {
      this.simulation.setCollisionWorld(collision);
      console.log('[FPSGameManager] Collision world set on local simulation');
    }

    // Also set on NetworkGameHost's prediction simulation (for network mode)
    const networkHost = this.gameHost as any;
    if (networkHost && typeof networkHost.setCollisionWorld === 'function') {
      networkHost.setCollisionWorld(collision);
      console.log('[FPSGameManager] Collision world set on network prediction simulation');
    }

    // Set on V2NetworkClient for Q3-style prediction (network mode)
    if (this.v2Client) {
      this.v2Client.setCollisionWorld(collision);
      console.log('[FPSGameManager] Collision world set on V2NetworkClient');
    }
  }
}
