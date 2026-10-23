import type { BotInput } from "./BotBrain";
import type { BotDifficulty } from "./BotConfig";
import type { BotGameState, Vec3, VisiblePlayer } from "./BotGameState";
import type { MovementOpportunity } from "./BotMovementAnalyzer";
import type { BotNavGraph, NavStep } from "./BotNavGraph";
import type { BotVision, VisionResult } from "./BotVision";
import type { LearnedRoute } from "./LearnedRoutes";
import type { LedgeSlideJumpPlan } from "./LedgeSlideJump";

export type BotSequenceStatus = "running" | "succeeded" | "failed";

export interface BotSequenceContext {
  state: BotGameState;
  vision?: BotVision | null;
  visionResult?: VisionResult | null;
  navGraph?: BotNavGraph | null;
  navStep?: NavStep | null;
  movementOpportunity?: MovementOpportunity | null;
  /** The learned route a `jump` step follows, when it is one (see LearnedRoutes.ts). */
  learnedRoute?: LearnedRoute | null;
  /** State-machine input that an optional movement sequence may take over. */
  proposedInput?: BotInput | null;
  difficulty?: BotDifficulty | null;
  /** Brain-owned cooldown/precondition result for starting a route slide. */
  crouchslideReady?: boolean;
  /** Stable authoritative pickup target for a specialized final-lane slide. */
  itemSlideTarget?: { pickupId: number; position: Vec3 } | null;
  /** Brain-owned route-shape, availability, and cooldown result. */
  itemSlideReady?: boolean;

  /** The enemy a combat sequence (the slide-blade lunge) goes for. */
  combatTarget?: VisiblePlayer | null;
  /** Brain-owned route-shape/safety result for starting a strafe-jump hop. */
  routeStrafeReady?: boolean;
  /** Deterministic fallback side when route error does not prefer one. */
  routeStrafeSide?: -1 | 1;
  ledgeSlidePlan?: LedgeSlideJumpPlan | null;
}

export interface BotSequenceState {
  phase: string;
  startedTick: number;
  phaseStartedTick: number;
  commitUntilTick: number;
  data: Record<string, unknown>;
}

export interface BotSequenceTick {
  input: BotInput;
  status: BotSequenceStatus;
  phase: string;
  reason?: string;
  commitForTicks?: number;
}

export interface BotSequence {
  readonly id: string;
  readonly tags: readonly string[];
  readonly maxTicks: number;

  score(context: BotSequenceContext): number | null;
  start(context: BotSequenceContext): BotSequenceState;
  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick;
  abort?(context: BotSequenceContext, state: BotSequenceState, reason: string): void;
}

export interface BotSequenceRuntimeTick extends BotSequenceTick {
  sequenceId: string;
}

interface ActiveSequence {
  sequence: BotSequence;
  state: BotSequenceState;
}

/**
 * Head for `target`, and look there too while it is at least `holdWithin`
 * away horizontally. Nearer, the bearing to it swings round as the bot passes
 * over or beside it (the jump pad spin), so the view stays where it is.
 */
export function steerToward(
  self: { position: Vec3; yaw: number },
  target: Vec3,
  holdWithin: number,
): { yaw: number; moveYaw?: number } {
  const dx = target.x - self.position.x;
  const dz = target.z - self.position.z;
  const distance = Math.hypot(dx, dz);
  const bearing = distance < 1 ? self.yaw : Math.atan2(dx, dz);
  return distance < holdWithin ? { yaw: self.yaw, moveYaw: bearing } : { yaw: bearing };
}

function neutralInput(state: BotGameState): BotInput {
  return {
    direction: { x: 0, y: 0, z: 0 },
    pitch: state.self.pitch,
    yaw: state.self.yaw,
    buttons: 0,
    weaponSlot: 0,
  };
}

/** Deterministic registry: score descending, then sequence id ascending. */
export class BotSequenceRegistry {
  private readonly sequences = new Map<string, BotSequence>();

  register(sequence: BotSequence): void {
    if (this.sequences.has(sequence.id)) {
      throw new Error(`Bot sequence "${sequence.id}" is already registered`);
    }
    this.sequences.set(sequence.id, sequence);
  }

  get(id: string): BotSequence | null {
    return this.sequences.get(id) ?? null;
  }

  choose(context: BotSequenceContext): BotSequence | null {
    let best: { sequence: BotSequence; score: number } | null = null;
    for (const sequence of this.sequences.values()) {
      const score = sequence.score(context);
      if (score === null || !Number.isFinite(score)) continue;
      if (!best || score > best.score || (score === best.score && sequence.id.localeCompare(best.sequence.id) < 0)) {
        best = { sequence, score };
      }
    }
    return best?.sequence ?? null;
  }
}

/**
 * Owns at most one committed action sequence.
 *
 * Time is always measured in authoritative simulation ticks from BotGameState,
 * never in snapshot/brain invocation counts.
 */
export class BotSequenceRuntime {
  private active: ActiveSequence | null = null;
  private lastTerminal: BotSequenceRuntimeTick | null = null;
  private lastAbortReason: string | null = null;

  constructor(private readonly registry: BotSequenceRegistry) {}

  get isActive(): boolean {
    return this.active !== null;
  }

  get activeSequenceId(): string | null {
    return this.active?.sequence.id ?? null;
  }

  get terminalResult(): BotSequenceRuntimeTick | null {
    return this.lastTerminal;
  }

  get abortReason(): string | null {
    return this.lastAbortReason;
  }

  isCommitted(tick: number): boolean {
    return this.active !== null && tick < this.active.state.commitUntilTick;
  }

  getDebug(tick: number): string | null {
    if (!this.active) return null;
    const commitment = this.isCommitted(tick) ? ` committed=${this.active.state.commitUntilTick - tick}` : "";
    return `sequence=${this.active.sequence.id} phase=${this.active.state.phase}${commitment}`;
  }

  startBest(context: BotSequenceContext): boolean {
    const sequence = this.registry.choose(context);
    return sequence ? this.start(sequence.id, context) : false;
  }

  start(sequenceId: string, context: BotSequenceContext): boolean {
    if (this.active) return false;
    const sequence = this.registry.get(sequenceId);
    if (!sequence || sequence.score(context) === null) return false;

    const initial = sequence.start(context);
    this.active = {
      sequence,
      state: {
        ...initial,
        startedTick: context.state.tick,
        phaseStartedTick: context.state.tick,
        commitUntilTick: Math.max(context.state.tick, initial.commitUntilTick),
        data: { ...initial.data },
      },
    };
    this.lastTerminal = null;
    this.lastAbortReason = null;
    return true;
  }

  tick(context: BotSequenceContext): BotSequenceRuntimeTick | null {
    const active = this.active;
    if (!active) return null;

    if (context.state.tick - active.state.startedTick >= active.sequence.maxTicks) {
      const timeout: BotSequenceRuntimeTick = {
        sequenceId: active.sequence.id,
        input: neutralInput(context.state),
        status: "failed",
        phase: active.state.phase,
        reason: "timeout",
      };
      this.lastTerminal = timeout;
      this.active = null;
      return timeout;
    }

    const result = active.sequence.tick(context, active.state);
    if (result.phase !== active.state.phase) {
      active.state.phase = result.phase;
      active.state.phaseStartedTick = context.state.tick;
    }
    if (result.commitForTicks !== undefined) {
      const ticks = Math.max(0, Math.floor(result.commitForTicks));
      active.state.commitUntilTick = Math.max(active.state.commitUntilTick, context.state.tick + ticks);
    }

    const runtimeResult: BotSequenceRuntimeTick = {
      ...result,
      sequenceId: active.sequence.id,
    };
    if (result.status !== "running") {
      this.lastTerminal = runtimeResult;
      this.active = null;
    }
    return runtimeResult;
  }

  interrupt(context: BotSequenceContext, reason: string, force: boolean = false): boolean {
    const active = this.active;
    if (!active) return true;
    if (!force && this.isCommitted(context.state.tick)) return false;

    active.sequence.abort?.(context, active.state, reason);
    this.lastAbortReason = reason;
    this.active = null;
    return true;
  }
}
