import { Simulation, SimulationConfig } from '../../../engine/network/core/Simulation';
import { GameState, PlayerState } from '../../../engine/network/core/GameState';
import { Entity } from '../../../engine/network/core/Entity';
import type { Command } from '../../../engine/network/core/Command';
import { MovementSystem } from '../../../engine/network/systems/MovementSystem';
import { TransformComponent } from '../../../engine/network/components/TransformComponent';
import { VelocityComponent } from '../../../engine/network/components/VelocityComponent';
import { InputComponent } from '../../../engine/network/components/InputComponent';
import { MovementStateComponent } from '../../../engine/network/components/MovementStateComponent';
import { NullCollisionWorld, type CollisionWorld } from '../../../engine/network/systems/collision/CollisionWorld';
import { FPSMovementProfile } from './FPSMovementProfile';

/**
 * FPS-specific command for player input
 */
export interface FPSInputCommand extends Command {
  type: 'fps_input';
  direction: { x: number; y: number; z: number };
  pitch: number;
  yaw: number;
  buttons: number;
}

/**
 * FPSSimulation - Server-side game simulation for FPS
 *
 * This simulation handles:
 * - Player movement (using FPSMovementProfile)
 * - Input processing
 * - Entity spawning
 *
 * Future additions:
 * - Projectile system
 * - Damage system
 * - Weapon system
 */
export class FPSSimulation extends Simulation<GameState, FPSInputCommand> {
  // NOTE: movementSystem is declared but NOT initialized here!
  // ES2022 class field initializers run AFTER super() returns, which would overwrite
  // the value set during registerSystems(). By using 'declare', we tell TypeScript
  // the field exists but don't emit any initialization code.
  declare private movementSystem: MovementSystem;
  private pendingCollisionWorld: CollisionWorld | null = null;
  private spawnPoints: Array<{ x: number; y: number; z: number }> = [];
  private nextEntityId: number = 1;

  constructor(config: SimulationConfig) {
    super(config);

    // Verify movementSystem was set during registerSystems (called by super)
    if (!this.movementSystem) {
      throw new Error('[FPSSimulation] movementSystem was not initialized by registerSystems!');
    }

    // Default spawn points (will be loaded from map later)
    this.spawnPoints = [
      { x: 0, y: 10, z: 0 },
      { x: 100, y: 10, z: 100 },
      { x: -100, y: 10, z: -100 },
    ];

    console.log('[FPSSimulation] Initialized with FPSMovementProfile');
  }

  protected createInitialState(): GameState {
    return new GameState();
  }

  protected registerSystems(): void {
    try {
      // Initialize movement system with FPS profile
      const movementProfile = new FPSMovementProfile();
      const collisionWorld = new NullCollisionWorld(); // Will be replaced with BSP collision

      const ms = new MovementSystem(movementProfile, collisionWorld);
      this.movementSystem = ms;
      this.addSystem(ms);
      console.log('[FPSSimulation] registerSystems completed, movementSystem:', !!this.movementSystem);

      // Apply any pending collision world
      if (this.pendingCollisionWorld) {
        console.log('[FPSSimulation] Applying pending collision world');
        ms.setCollisionWorld(this.pendingCollisionWorld);
        this.pendingCollisionWorld = null;
      }
    } catch (err) {
      console.error('[FPSSimulation] ERROR in registerSystems:', err);
    }
  }

  protected registerCommandHandlers(): void {
    this.onCommand('fps_input', this.handleInputCommand.bind(this));
  }

  /**
   * Handle player input command
   */
  private handleInputCommand(state: GameState, cmd: FPSInputCommand): void {
    const player = state.players.get(cmd.playerId);
    if (!player) {
      console.warn(`[FPSSimulation] Unknown player: ${cmd.playerId}`);
      return;
    }

    const entity = state.entities.get(player.entityId);
    if (!entity) {
      console.warn(`[FPSSimulation] No entity for player: ${cmd.playerId}`);
      return;
    }

    // Update input component
    const input = entity.getComponent<InputComponent>('input');
    if (input) {
      input.buttons = cmd.buttons;
      input.viewAngles.pitch = cmd.pitch;
      input.viewAngles.yaw = cmd.yaw;
      input.moveDirection = { ...cmd.direction };
      input.sequence = cmd.seq;
      input.tick = cmd.tick;
    }

    // Update transform rotation to match view
    const transform = entity.getComponent<TransformComponent>('transform');
    if (transform) {
      transform.rotation.x = cmd.pitch;
      transform.rotation.y = cmd.yaw;
    }
  }

  /**
   * Create a player entity when they join
   */
  spawnPlayer(playerId: string): Entity {
    const entityId = `player_${this.nextEntityId++}`;
    const entity = new Entity(entityId);

    // Get spawn point
    const spawnIndex = Math.floor(Math.random() * this.spawnPoints.length);
    const spawnPoint = this.spawnPoints[spawnIndex];

    // Add components
    const transform = new TransformComponent({
      position: { ...spawnPoint },
      rotation: { x: 0, y: 0, z: 0 },
    });
    entity.addComponent('transform', transform);

    const velocity = new VelocityComponent();
    entity.addComponent('velocity', velocity);

    const input = new InputComponent();
    entity.addComponent('input', input);

    const movementState = new MovementStateComponent();
    entity.addComponent('movementState', movementState);

    // Add to state
    this.state.entities.set(entityId, entity);

    // Create player state
    const playerState = new PlayerState();
    playerState.entityId = entityId;
    playerState.name = playerId;
    this.state.players.set(playerId, playerState);

    console.log(`[FPSSimulation] Spawned player ${playerId} at entity ${entityId}`, spawnPoint);

    return entity;
  }

  /**
   * Remove a player when they disconnect
   */
  despawnPlayer(playerId: string): void {
    const player = this.state.players.get(playerId);
    if (player) {
      this.state.entities.delete(player.entityId);
      this.state.players.delete(playerId);
      console.log(`[FPSSimulation] Despawned player ${playerId}`);
    }
  }

  /**
   * Set spawn points (called when map loads)
   */
  setSpawnPoints(points: Array<{ x: number; y: number; z: number }>): void {
    this.spawnPoints = points;
    console.log(`[FPSSimulation] Set ${points.length} spawn points`);
  }

  /**
   * Get the movement system (for setting collision world later)
   */
  getMovementSystem(): MovementSystem {
    return this.movementSystem;
  }

  /**
   * Set the collision world (called when map loads)
   */
  setCollisionWorld(collision: CollisionWorld | null): void {
    console.log(`[FPSSimulation] setCollisionWorld called with: ${collision ? collision.constructor.name : 'null'}`);
    if (!this.movementSystem) {
      // Store for later - will be applied when movementSystem is ready
      console.warn('[FPSSimulation] movementSystem not ready, storing pending collision world');
      this.pendingCollisionWorld = collision;
      return;
    }
    this.movementSystem.setCollisionWorld(collision);
    console.log(`[FPSSimulation] Collision world forwarded to MovementSystem`);
  }
}
