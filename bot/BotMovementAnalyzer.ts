/**
 * Deterministic, bounded movement rollout analysis for bot navigation.
 *
 * Every rollout uses a fresh MovementProfile and the same 125 Hz fixed tick as
 * authoritative gameplay. The analyzer never mutates a live player or bot.
 */

import { InputButtons } from "../../../engine/network/components/InputComponent";
import type { MovementInput } from "../../../engine/network/systems/movement/MovementProfile";
import type { TriggerVolume } from "../../../shared/bsp/TriggerTable";
import type { CollisionWorld } from "../../../shared/collision/CollisionWorld";
import type { Vec3 } from "../shared/bsp/BspDataLoader";
import { MovementProfile } from "../simulation/MovementProfile";

export type TraversalKind = "jump" | "strafe_jump" | "slide_jump" | "wall_jump" | "wall_jump_ledge_grab";

export interface MovementInputPlan {
  direction: Vec3;
  initialSpeed: number;
  buttons: number;
  jumpTicks: number;
  maxTicks: number;
}

export interface MovementOpportunity {
  id: string;
  kind: TraversalKind;
  fromNodeId: number;
  toNodeId: number;
  takeoff: {
    position: Vec3;
    radius: number;
    minSpeed: number;
    maxSpeed: number;
    yawRange: [number, number];
  };
  landing: {
    position: Vec3;
    radius: number;
    surfaceNormal: Vec3;
  };
  inputPlan: MovementInputPlan;
  expectedTicks: number;
  successMargin: number;
  risk: {
    fallDamage: boolean;
    requiresLedgeGrab: boolean;
  };
}

export type MovementRejectionReason =
  | "rollout_budget_exhausted"
  | "invalid_takeoff"
  | "invalid_landing"
  | "outside_ballistic_envelope"
  | "rollout_missed_landing";

export interface MovementRejection {
  id: string;
  kind: TraversalKind;
  fromNodeId: number;
  toNodeId: number;
  takeoff: Vec3;
  landing: Vec3;
  reason: MovementRejectionReason;
}

export interface MovementAnalysisSummary {
  candidateCount: number;
  rolloutCount: number;
  acceptedCount: number;
  rejectedCount: number;
  budgetExhausted: boolean;
  rejectionCounts: Partial<Record<MovementRejectionReason, number>>;
}

export interface MovementCandidateResult {
  opportunity: MovementOpportunity | null;
  rejection: MovementRejection | null;
}

export interface BotMovementAnalyzerConfig {
  tickRate: number;
  maxTicks: number;
  maxRollouts: number;
  landingRadius: number;
  stableGroundTicks: number;
  candidateSpeeds: number[];
}

const PLAYER_FEET_OFFSET = 24;
const STANDING_CLEARANCE = 1;
const SURFACE_PROBE_UP = 8;
const SURFACE_PROBE_DOWN = 128;
const MIN_WALK_NORMAL = 0.7;
const MAX_ANALYZED_HEIGHT = 96;
const MAX_ANALYZED_HORIZONTAL_DISTANCE = 480;
const MAX_STORED_REJECTIONS = 256;
/** A teleporter exit's origin sits this far above its destination. */
const TELEPORT_EXIT_LIFT = 25;
/** Speed assumed going into a teleporter: running. */
const TELEPORT_ENTRY_SPEED = 320;
/** Longest jump pad flight followed to its landing (4 s at 125 Hz). */
const JUMPPAD_FLIGHT_TICKS = 500;
/** Steering directions tried per jump pad, besides straight at its target. */
const JUMPPAD_STEER_DIRECTIONS = 16;
/** A landing must be this far beyond the pad's edge, horizontally. */
const JUMPPAD_LANDING_CLEARANCE = 32;
/** Landings closer than this are the same landing. */
const JUMPPAD_LANDING_SPACING = 160;
/** A flight steered at a landing must arrive this close to it. */
const JUMPPAD_LANDING_TOLERANCE = 64;

export const BOT_MOVEMENT_ANALYZER_VERSION = 2;

const DEFAULT_CONFIG: BotMovementAnalyzerConfig = {
  tickRate: 125,
  maxTicks: 150,
  maxRollouts: 4096,
  landingRadius: 48,
  stableGroundTicks: 2,
  candidateSpeeds: [0, 160, 280, 400],
};

const ROLLOUT_PROFILE_OVERRIDES = {
  ledgeGrabEnabled: false,
  wallJumpEnabled: false,
  slideEnabled: false,
} as const;

const rolloutProfileFingerprint = new MovementProfile(ROLLOUT_PROFILE_OVERRIDES).getDeterminismFingerprint();
export const BOT_MOVEMENT_ANALYZER_FINGERPRINT = [
  `rollout:${BOT_MOVEMENT_ANALYZER_VERSION}`,
  `budget:${DEFAULT_CONFIG.tickRate}:${DEFAULT_CONFIG.maxTicks}:${DEFAULT_CONFIG.maxRollouts}`,
  `speeds:${DEFAULT_CONFIG.candidateSpeeds.join(",")}`,
  `landing:${DEFAULT_CONFIG.landingRadius}:${DEFAULT_CONFIG.stableGroundTicks}`,
  `standing:${PLAYER_FEET_OFFSET}:${STANDING_CLEARANCE}:${SURFACE_PROBE_UP}:${SURFACE_PROBE_DOWN}:${MIN_WALK_NORMAL}`,
  `envelope:${MAX_ANALYZED_HEIGHT}:${MAX_ANALYZED_HORIZONTAL_DISTANCE}`,
  `movement:${rolloutProfileFingerprint}`,
].join("|");

interface RolloutSuccess {
  ticks: number;
  minDistance: number;
  landingPosition: Vec3;
}

/** Runs reproducible offline movement trials against one map collision world. */
export class BotMovementAnalyzer {
  private readonly config: BotMovementAnalyzerConfig;
  private readonly opportunities: MovementOpportunity[] = [];
  private readonly rejections: MovementRejection[] = [];
  private readonly summary: MovementAnalysisSummary = {
    candidateCount: 0,
    rolloutCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    budgetExhausted: false,
    rejectionCounts: {},
  };

  constructor(
    private readonly collision: CollisionWorld,
    config: Partial<BotMovementAnalyzerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.candidateSpeeds = [...(config.candidateSpeeds ?? DEFAULT_CONFIG.candidateSpeeds)].sort((a, b) => a - b);
  }

  get accepted(): ReadonlyArray<MovementOpportunity> {
    return this.opportunities;
  }

  get rejected(): ReadonlyArray<MovementRejection> {
    return this.rejections;
  }

  get analysisSummary(): MovementAnalysisSummary {
    return {
      ...this.summary,
      rejectionCounts: { ...this.summary.rejectionCounts },
    };
  }

  analyzeJump(fromNodeId: number, fromHint: Vec3, toNodeId: number, toHint: Vec3): MovementCandidateResult {
    const id = `jump:${fromNodeId}->${toNodeId}`;
    this.summary.candidateCount++;

    const takeoff = this.resolveStandingOrigin(fromHint);
    if (!takeoff) return this.reject(id, fromNodeId, fromHint, toNodeId, toHint, "invalid_takeoff");

    const landing = this.resolveStandingOrigin(toHint);
    if (!landing) return this.reject(id, fromNodeId, takeoff, toNodeId, toHint, "invalid_landing");

    const dx = landing.x - takeoff.x;
    const dz = landing.z - takeoff.z;
    const horizontalDistance = Math.hypot(dx, dz);
    const heightDelta = landing.y - takeoff.y;
    if (
      horizontalDistance < 1 ||
      horizontalDistance > MAX_ANALYZED_HORIZONTAL_DISTANCE ||
      Math.abs(heightDelta) > MAX_ANALYZED_HEIGHT
    ) {
      return this.reject(id, fromNodeId, takeoff, toNodeId, landing, "outside_ballistic_envelope");
    }

    const direction = { x: dx / horizontalDistance, y: 0, z: dz / horizontalDistance };
    for (const initialSpeed of this.config.candidateSpeeds) {
      if (this.summary.rolloutCount >= this.config.maxRollouts) {
        this.summary.budgetExhausted = true;
        return this.reject(id, fromNodeId, takeoff, toNodeId, landing, "rollout_budget_exhausted");
      }

      this.summary.rolloutCount++;
      const success = this.rolloutJump(takeoff, landing, direction, initialSpeed);
      if (!success) continue;

      const yaw = Math.atan2(direction.x, direction.z);
      const opportunity: MovementOpportunity = {
        id,
        kind: "jump",
        fromNodeId,
        toNodeId,
        takeoff: {
          position: { ...takeoff },
          radius: 32,
          minSpeed: initialSpeed,
          maxSpeed: initialSpeed,
          yawRange: [yaw - 0.12, yaw + 0.12],
        },
        landing: {
          position: { ...success.landingPosition },
          radius: this.config.landingRadius,
          surfaceNormal: { x: 0, y: 1, z: 0 },
        },
        inputPlan: {
          direction,
          initialSpeed,
          buttons: InputButtons.FORWARD | InputButtons.SPRINT | InputButtons.JUMP,
          jumpTicks: 1,
          maxTicks: this.config.maxTicks,
        },
        expectedTicks: success.ticks,
        successMargin: Math.max(0, this.config.landingRadius - success.minDistance),
        risk: {
          fallDamage: heightDelta < -128,
          requiresLedgeGrab: false,
        },
      };
      this.opportunities.push(opportunity);
      this.summary.acceptedCount++;
      return { opportunity, rejection: null };
    }

    return this.reject(id, fromNodeId, takeoff, toNodeId, landing, "rollout_missed_landing");
  }

  /**
   * Where a jump pad can put a player. Each candidate flight steers one way
   * from launch to landing with the game's own movement; a landing counts when
   * it is clear of the pad and above it, and when a second flight that steers
   * at the landing point itself (as a bot will) arrives there too. A pad that
   * throws straight up has a landing on every ledge within reach; a pad aimed
   * across a gap usually has one.
   */
  simulateJumppadLandings(pad: TriggerVolume): Vec3[] {
    const padTop = pad.max.y;
    const center = { x: (pad.min.x + pad.max.x) / 2, z: (pad.min.z + pad.max.z) / 2 };
    const padRadius = Math.hypot(pad.max.x - pad.min.x, pad.max.z - pad.min.z) / 2;
    const landings: Vec3[] = [];
    const toTarget = Math.atan2(pad.dest.x - center.x, pad.dest.z - center.z);
    const yaws = [
      toTarget,
      ...Array.from({ length: JUMPPAD_STEER_DIRECTIONS }, (_, i) => (i * 2 * Math.PI) / JUMPPAD_STEER_DIRECTIONS),
    ];
    for (const yaw of yaws) {
      const heading = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
      const landing = this.flyJumppad(pad, () => heading);
      if (!landing) continue;
      if (Math.hypot(landing.x - center.x, landing.z - center.z) <= padRadius + JUMPPAD_LANDING_CLEARANCE) continue;
      if (landing.y - PLAYER_FEET_OFFSET < padTop) continue;
      if (
        landings.some(
          (l) =>
            Math.hypot(l.x - landing.x, l.z - landing.z) < JUMPPAD_LANDING_SPACING && Math.abs(l.y - landing.y) < 32,
        )
      )
        continue;
      const steered = this.flyJumppad(pad, (position) => {
        const dx = landing.x - position.x;
        const dz = landing.z - position.z;
        const length = Math.hypot(dx, dz);
        return length > 1 ? { x: dx / length, y: 0, z: dz / length } : null;
      });
      if (!steered || Math.hypot(steered.x - landing.x, steered.z - landing.z) > JUMPPAD_LANDING_TOLERANCE) continue;
      if (Math.abs(steered.y - landing.y) > 32) continue;
      landings.push(steered);
    }
    return landings;
  }

  /**
   * Where a player leaving a teleporter lands. The exit keeps the speed the
   * player went in with, along the destination's facing, so an exit can carry
   * a running player across a gap a standstill never crosses. Simulated at
   * running speed, holding forward along the exit facing. Null if it does not
   * land within the tick budget.
   */
  simulateTeleportLanding(teleporter: TriggerVolume): Vec3 | null {
    const yaw = teleporter.destYaw ?? 0;
    const heading = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
    const profile = new MovementProfile();
    profile.resetPhysicsState(false);
    let position = { x: teleporter.dest.x, y: teleporter.dest.y + TELEPORT_EXIT_LIFT, z: teleporter.dest.z };
    let velocity = { x: heading.x * TELEPORT_ENTRY_SPEED, y: 0, z: heading.z * TELEPORT_ENTRY_SPEED };
    const deltaTime = 1 / this.config.tickRate;
    for (let tick = 1; tick <= JUMPPAD_FLIGHT_TICKS; tick++) {
      const input: MovementInput = {
        direction: heading,
        viewAngles: { pitch: 0, yaw },
        buttons: InputButtons.FORWARD,
        sequence: tick,
        isPressed(button: number): boolean {
          return (this.buttons & button) !== 0;
        },
      };
      const result = profile.simulate(position, velocity, input, deltaTime, this.collision);
      position = result.position;
      velocity = result.velocity;
      if (result.grounded && tick > 1) return { ...position };
    }
    return null;
  }

  /** One jump pad flight from standing in the pad until grounded again; null if it never lands. */
  private flyJumppad(pad: TriggerVolume, steer: (position: Vec3) => Vec3 | null): Vec3 | null {
    const profile = new MovementProfile();
    profile.resetPhysicsState(true);
    profile.setTriggerVolumes([pad]);
    const center = {
      x: (pad.min.x + pad.max.x) / 2,
      y: Math.max(pad.min.y, pad.max.y - 8) + PLAYER_FEET_OFFSET,
      z: (pad.min.z + pad.max.z) / 2,
    };
    const floor = this.collision.trace(center, { x: center.x, y: pad.min.y - SURFACE_PROBE_DOWN, z: center.z });
    let position =
      floor.hit && floor.hitPoint
        ? { x: center.x, y: floor.hitPoint.y + PLAYER_FEET_OFFSET + STANDING_CLEARANCE, z: center.z }
        : center;
    let velocity = { x: 0, y: 0, z: 0 };
    const deltaTime = 1 / this.config.tickRate;
    let launched = false;
    for (let tick = 1; tick <= JUMPPAD_FLIGHT_TICKS; tick++) {
      const direction = launched ? steer(position) : null;
      const input: MovementInput = {
        direction: direction ?? { x: 0, y: 0, z: 0 },
        viewAngles: { pitch: 0, yaw: direction ? Math.atan2(direction.x, direction.z) : 0 },
        buttons: direction ? InputButtons.FORWARD : 0,
        sequence: tick,
        isPressed(button: number): boolean {
          return (this.buttons & button) !== 0;
        },
      };
      const result = profile.simulate(position, velocity, input, deltaTime, this.collision);
      position = result.position;
      velocity = result.velocity;
      if (!result.grounded && velocity.y > 0) launched = true;
      if (launched && result.grounded) return { ...position };
    }
    return null;
  }

  private resolveStandingOrigin(hint: Vec3): Vec3 | null {
    const start = { x: hint.x, y: hint.y + SURFACE_PROBE_UP, z: hint.z };
    const end = { x: hint.x, y: hint.y - SURFACE_PROBE_DOWN, z: hint.z };
    const floor = this.collision.trace(start, end);
    if (!floor.hit) return null;
    if (!floor.hitPoint || !floor.normal || floor.normal.y < MIN_WALK_NORMAL) return null;
    return {
      x: floor.hitPoint.x,
      y: floor.hitPoint.y + PLAYER_FEET_OFFSET + STANDING_CLEARANCE,
      z: floor.hitPoint.z,
    };
  }

  private rolloutJump(takeoff: Vec3, landing: Vec3, direction: Vec3, initialSpeed: number): RolloutSuccess | null {
    const profile = new MovementProfile(ROLLOUT_PROFILE_OVERRIDES);
    profile.resetPhysicsState(true);

    let position = { ...takeoff };
    let velocity = { x: direction.x * initialSpeed, y: 0, z: direction.z * initialSpeed };
    let wasAirborne = false;
    let stableTicks = 0;
    let minDistance = Number.POSITIVE_INFINITY;
    const deltaTime = 1 / this.config.tickRate;

    for (let tick = 1; tick <= this.config.maxTicks; tick++) {
      const buttons = InputButtons.FORWARD | InputButtons.SPRINT | (tick <= 1 ? InputButtons.JUMP : 0);
      const input: MovementInput = {
        direction,
        viewAngles: { pitch: 0, yaw: Math.atan2(direction.x, direction.z) },
        buttons,
        sequence: tick,
        isPressed(button: number): boolean {
          return (this.buttons & button) !== 0;
        },
      };
      const result = profile.simulate(position, velocity, input, deltaTime, this.collision);
      position = result.position;
      velocity = result.velocity;

      if (!result.grounded) wasAirborne = true;
      const horizontalDistance = Math.hypot(position.x - landing.x, position.z - landing.z);
      const verticalDistance = Math.abs(position.y - landing.y);
      if (verticalDistance <= 32) minDistance = Math.min(minDistance, horizontalDistance);

      if (wasAirborne && result.grounded && horizontalDistance <= this.config.landingRadius && verticalDistance <= 32) {
        stableTicks++;
        if (stableTicks >= this.config.stableGroundTicks) {
          return { ticks: tick, minDistance, landingPosition: { ...position } };
        }
      } else {
        stableTicks = 0;
      }
    }
    return null;
  }

  private reject(
    id: string,
    fromNodeId: number,
    takeoff: Vec3,
    toNodeId: number,
    landing: Vec3,
    reason: MovementRejectionReason,
  ): MovementCandidateResult {
    const rejection: MovementRejection = {
      id,
      kind: "jump",
      fromNodeId,
      toNodeId,
      takeoff: { ...takeoff },
      landing: { ...landing },
      reason,
    };
    if (this.rejections.length < MAX_STORED_REJECTIONS) {
      this.rejections.push(rejection);
    }
    this.summary.rejectedCount++;
    this.summary.rejectionCounts[reason] = (this.summary.rejectionCounts[reason] ?? 0) + 1;
    return { opportunity: null, rejection };
  }
}
