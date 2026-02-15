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


import { getCollisionManager } from '../../engine/physics/CollisionManager';
import { createBSPCollisionWorld } from './simulation/collision/BSPCollisionWorld';
import { V2NetworkClient } from './client';
import type { ServerSnapshot } from './client';
import { MatchStateManager } from './client/MatchStateManager';
import { MatchHUD } from './client/MatchHUD';
import { MessageCodec } from '../../engine/network/protocol/MessageCodec';
import { getHitscanEffects } from '../../engine/weapon/HitscanEffects';
import { Vector3, Color3 } from '@babylonjs/core';

export interface FPSGameConfig {
  tickRate?: number;
  maxPlayers?: number;
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
  pitch: number;  // Camera X rotation
  yaw: number;    // Camera Y rotation
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

  // Callbacks
  private onStateUpdateCallbacks: ((state: PlayerStateUpdate) => void)[] = [];

  private pendingTick: number = 0;

  private constructor() { }

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

    console.log(`[FPSGameManager] Initializing local game at ${tickRate}Hz`);

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

    console.log(`[FPSGameManager] Local game initialized, player: ${this.localPlayerId}`);
  }

  /**
   * Initialize network game (multiplayer mode)
   * Connects to a dedicated server
   */
  async initializeNetwork(url: string, config: FPSGameConfig = {}): Promise<void> {
    // Guard against multiple initializations - shutdown first if already running
    if (this.isRunning) {
      console.log('[FPSGameManager] Shutting down existing game before connecting...');
      this.shutdown();
    }

    const tickRate = config.tickRate ?? 125;  // Must match server tick rate (125Hz)
    const maxPlayers = config.maxPlayers ?? 16;

    console.log(`[FPSGameManager] Connecting to server: ${url}`);

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
          console.log(`[FPSGameManager] Ignoring duplicate Welcome message for map: ${serverInfo.map}`);
          return;
        }
        mapLoadStarted = true;

        console.log(`[FPSGameManager] Server map: ${serverInfo.map}`);

        // Load the server's map via console command
        try {
          const { CommandRegistry } = await import('../../engine/console/CommandRegistry');
          const registry = CommandRegistry.getInstance();
          const result = await registry.execute(`map ${serverInfo.map}`);
          console.log(`[FPSGameManager] Map load result: ${result}`);

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
            console.log(`[FPSGameManager] CollisionManager instance: ${cm.getInstanceId()}`);
            console.log(`[FPSGameManager] CollisionManager.isInitialized() = ${cm.isInitialized()}`);
            console.log(`[FPSGameManager] CollisionManager.getBackendType() = ${cm.getBackendType()}`);
            if (cm.isInitialized()) {
              const collisionWorld = createBSPCollisionWorld();
              if (collisionWorld) {
                this.setCollisionWorld(collisionWorld);
                console.log(`[FPSGameManager] BSP collision injected into client prediction simulation`);

                // Test trace to verify collision works (use player bounds like server)
                const PLAYER_RADIUS = 16;
                const PLAYER_ORIGIN_HEIGHT = 24; // Q3: origin 24 above feet
                const testBounds = {
                  min: { x: -PLAYER_RADIUS, y: -PLAYER_ORIGIN_HEIGHT, z: -PLAYER_RADIUS },
                  max: { x: PLAYER_RADIUS, y: 32, z: PLAYER_RADIUS }  // 56 total: 24 below + 32 above
                };

                // Floor detection test at known position
                const testX = 880, testZ = 1508;
                const testStart = { x: testX, y: 200, z: testZ };
                const testEnd = { x: testX, y: 0, z: testZ };
                const testResult = collisionWorld.trace(testStart, testEnd, testBounds);
                const floorY = 200 - 200 * testResult.fraction;

                // For player physics, origin is at waist (24 above feet), so origin Y = floorY + 24
                const expectedOriginY = floorY + PLAYER_ORIGIN_HEIGHT;
                console.log(`[FPSGameManager] FLOOR TEST: traceFloorY=${floorY.toFixed(1)}, expectedOriginY=${expectedOriginY.toFixed(1)}`);

                // Now test stepSlideMove - start above expected position and let gravity pull down
                const stepSlideTestStart = { x: testX, y: expectedOriginY + 100, z: testZ };
                const stepSlideTestVel = { x: 0, y: -500, z: 0 };  // Falling velocity
                const stepSlideResult = collisionWorld.stepSlideMove(stepSlideTestStart, stepSlideTestVel, 0.5, testBounds);
                console.log(`[FPSGameManager] STEPSLIDEMOVE TEST: startY=${stepSlideTestStart.y.toFixed(1)}, endY=${stepSlideResult.endPos.y.toFixed(1)}, expectedY=${expectedOriginY.toFixed(1)}`);

                // Check if there's a Y offset between trace and stepSlideMove results
                const offset = stepSlideResult.endPos.y - expectedOriginY;
                if (Math.abs(offset) > 0.5) {
                  console.warn(`[FPSGameManager] Y OFFSET DETECTED: stepSlideMove returned ${stepSlideResult.endPos.y.toFixed(1)} but trace floor says origin should be ${expectedOriginY.toFixed(1)}, offset=${offset.toFixed(1)}`);
                }
                console.log(`[FPSGameManager] Test trace: fraction=${testResult.fraction.toFixed(4)}, hit=${testResult.hit}`);
              } else {
                console.warn(`[FPSGameManager] BSP collision world could not be created - backend not available`);
              }
            } else {
              console.warn(`[FPSGameManager] CollisionManager NOT initialized - client prediction will NOT have BSP collision!`);
            }

            const { CameraSystem } = await import('../../engine/camera/CameraSystem');
            const { FPSController } = await import('../../engine/camera/controllers/FPSController');
            const cameraSystem = CameraSystem.getInstance();

            // Ensure FPS controller is registered and active
            if (!cameraSystem.getController('fps')) {
              cameraSystem.registerController('fps', new FPSController());
            }
            cameraSystem.setController('fps');
            console.log(`[FPSGameManager] Switched to FPS camera mode after map load`);

            // Enable network mode on the FPSController
            const controller = cameraSystem.getActiveController();
            if (controller && controller.type === 'fps' && typeof (controller as any).enableNetworkMode === 'function') {
              (controller as any).enableNetworkMode();
              console.log(`[FPSGameManager] Enabled network mode on FPSController`);
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
      console.log(`[FPSGameManager] Created V2NetworkClient for prediction (before connect)`);

      // Tell NetworkGameHost to skip its prediction - V2NetworkClient handles it
      networkHost.setExternalPrediction(true);

      // Subscribe to state updates BEFORE connect so we don't miss snapshots
      // during the handshake. onServerStateUpdate() will use this.localPlayerId,
      // which gets updated to the server-assigned ID after connect resolves.
      this.gameHost.onStateUpdate((state: GameState) => {
        this.onServerStateUpdate(state);
      });

      // Connect to server (this triggers onServerInfo callback which loads map and sets collision)
      await networkHost.connect(url);

      // Update player ID after connect (server assigns it during handshake)
      this.localPlayerId = networkHost.localPlayerId;
      this.simulation = null; // No direct simulation access in network mode

      console.log(`[FPSGameManager] Connected to ${url}, player: ${this.localPlayerId}`);
      console.log(`[FPSGameManager] V2 client ready for Q3-style prediction/reconciliation`);

      // Initialize MatchHUD for match lifecycle display
      MatchHUD.getInstance().init();
      console.log(`[FPSGameManager] MatchHUD initialized`);
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
   * Get current server URL (if connected)
   */
  getServerUrl(): string | null {
    return this.serverUrl;
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

    console.log(`[FPSGameManager] Spawned local player: ${entity.id}`);
  }

  // Debug counter for sendInput tracing
  private sendInputCallCount = 0;

  /**
   * Send player input to simulation
   * Call this each frame from FPSController
   */
  sendInput(input: PlayerInputState): void {
    this.sendInputCallCount++;
    if (!this.gameHost || !this.isRunning) {
      if (this.sendInputCallCount % 500 === 1) {
        console.warn(`[FPSGameManager] sendInput SKIPPED #${this.sendInputCallCount}: gameHost=${!!this.gameHost}, isRunning=${this.isRunning}, isNetworkMode=${this.isNetworkMode}`);
      }
      return;
    }
    if (this.sendInputCallCount % 500 === 1) {
      console.log(`[FPSGameManager] sendInput ACTIVE #${this.sendInputCallCount}: gameHost=${!!this.gameHost}, isRunning=${this.isRunning}, connected=${this.gameHost.isConnected()}`);
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
      const pos = this.v2Client.getPosition();
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

    // Cleanup match state and HUD
    MatchHUD.getInstance().destroy();
    MatchStateManager.destroy();

    console.log('[FPSGameManager] Shutdown complete');
  }

  // Diagnostic counter for onServerStateUpdate
  private _stateUpdateCount = 0;

  /**
   * Handle state update from simulation
   */
  private onServerStateUpdate(state: GameState): void {
    this._stateUpdateCount++;

    // Dynamically sync localPlayerId from the game host.
    // JoinAccept sets networkHost.localPlayerId DURING connect(), but
    // FPSGameManager.localPlayerId is only copied AFTER connect() resolves.
    // This ensures we pick up the server-assigned ID as soon as JoinAccept arrives.
    if (this.gameHost && this.localPlayerId !== this.gameHost.localPlayerId) {
      console.log(`[FPSGameManager] Syncing localPlayerId: '${this.localPlayerId}' → '${this.gameHost.localPlayerId}'`);
      this.localPlayerId = this.gameHost.localPlayerId;
    }

    // === DIAGNOSTIC: Log first few calls ===
    if (this._stateUpdateCount <= 3) {
      const playerKeys = Array.from(state.players.keys());
      const entityKeys = Array.from(state.entities.keys());
      console.log(`[FPSGameManager] onServerStateUpdate #${this._stateUpdateCount}: tick=${state.tick}, localPlayerId='${this.localPlayerId}', players=[${playerKeys.join(',')}], entities=[${entityKeys.join(',')}], v2Client=${!!this.v2Client}, isNetworkMode=${this.isNetworkMode}`);
    }

    // Process match_state events before anything else
    if (state.events && state.events.length > 0) {
      const matchMgr = MatchStateManager.getInstance();
      const localEntityId = state.players.get(this.localPlayerId)?.entityId;

      for (const event of state.events) {
        if (event.type === 'match_state') {
          matchMgr.processEvent(event);
        } else if (event.type === 'weapon_fire') {
          // Skip our own fire events — we already display our own effects locally
          if (event.entityId === localEntityId) continue;
          this.handleRemoteWeaponFire(event);
        }
      }
    }

    const player = state.players.get(this.localPlayerId);
    if (!player) {
      if (this._stateUpdateCount <= 5 || this._stateUpdateCount % 500 === 0) {
        console.warn(`[FPSGameManager] onServerStateUpdate #${this._stateUpdateCount}: NO PLAYER for '${this.localPlayerId}'. Player keys: [${Array.from(state.players.keys()).join(',')}]`);
      }
      return;
    }

    const entity = state.entities.get(player.entityId);
    if (!entity) {
      if (this._stateUpdateCount <= 5 || this._stateUpdateCount % 500 === 0) {
        console.warn(`[FPSGameManager] onServerStateUpdate #${this._stateUpdateCount}: NO ENTITY for '${player.entityId}'. Entity keys: [${Array.from(state.entities.keys()).join(',')}]`);
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

      if (this._stateUpdateCount <= 3) {
        console.log(`[FPSGameManager] BUFFERED snapshot #${this._stateUpdateCount}: tick=${state.tick}, pos=(${transform.position.x.toFixed(1)},${transform.position.y.toFixed(1)},${transform.position.z.toFixed(1)})`);
      }

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

      // Projectile weapons — visual projectile entities come in Phase 3
      case 'gunblade':
      case 'glauncher':
      case 'rlauncher':
      case 'plasmagun':
        // TODO: Spawn client-side projectile entity from event origin & direction
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
