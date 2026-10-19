/**
 * MovementValidator — Anti-Warp / Speed Hack Prevention
 *
 * Watches for clients sending movement faster than real time. Two layers:
 *
 * 1. **Flood guard**: a hard limit on inputs accepted per server tick, sized for
 *    the backlog an honest link delivers at once after a half-second stall.
 *    Inputs over it are silently dropped.
 * 2. **Time budget**: each client earns real-time credit between inputs, up to
 *    500 ms banked, and each input costs 1/expectedClientRate seconds. Running
 *    out only records a strike. It does not drop the input: honest links
 *    deliver in bursts, and dropping there made honest players stutter.
 *
 * The real speed-hack defence is elsewhere: the simulation runs one command per
 * entity per tick and holds at most `MAX_INPUT_BUFFER` of them, so a flood
 * cannot buy extra movement however it arrives. Strikes are a signal for
 * telemetry, kept per player across spectating, rejoining and resuming, so
 * toggling spectate does not wipe the record. Only a real departure does.
 */

import type { PlayerId } from "@engine/server/ecs/types";

interface ClientMovementState {
  /** Accumulated real-time credit (ms). Earned by real time passing, spent by inputs. */
  timeBudget: number;
  /** performance.now() of last accepted input */
  lastInputTime: number;
  /** Number of inputs accepted this server tick (reset each tick) */
  inputsThisTick: number;
  /** Cumulative anti-warp violations */
  warpStrikes: number;
  /** Total inputs accepted (for stats) */
  totalAccepted: number;
  /** Total inputs rejected (for stats) */
  totalRejected: number;
}

/** What a player's record keeps while they are not playing. */
type Lifetime = Pick<ClientMovementState, "warpStrikes" | "totalAccepted" | "totalRejected">;

/** Inputs one tick accepts however they arrive: 512 ms of commands at 125 Hz. */
export const MAX_BURST_INPUTS = 64;

export class MovementValidator {
  private clients = new Map<PlayerId, ClientMovementState>();
  /** Records of players spectating or suspended, restored when they play again. */
  private parked = new Map<PlayerId, Lifetime>();

  // --- Config ---

  /** Max real-time that can be banked (ms). Prevents banking time by idling. */
  private maxBudgetMs: number;
  /** Cost per input in ms (= 1000 / expectedClientRate) */
  private inputCostMs: number;
  /** Hard cap on inputs per server tick */
  private maxInputsPerTick: number;
  /** Strikes before logging a warning */
  private strikeWarnThreshold: number;

  /**
   * @param expectedClientRate Expected client input rate in Hz (e.g. 144)
   * @param serverTickRate Server tick rate in Hz (e.g. 128)
   */
  constructor(expectedClientRate: number = 144, serverTickRate: number = 128) {
    this.inputCostMs = 1000 / expectedClientRate;
    // ceil(clientRate/serverRate) + 2 for jitter tolerance
    // A client emits one burst per rendered frame, and a stalled TCP link
    // delivers everything it held at once: a 20 FPS client already sends six
    // or seven a frame. Only a flood is refused; the simulation's one-per-tick
    // consumption is what keeps a fast sender from gaining time.
    this.maxInputsPerTick = Math.max(Math.ceil(expectedClientRate / serverTickRate) + 2, MAX_BURST_INPUTS);
    // Allow banking up to ~500ms of time (handles bursty/jittery links)
    this.maxBudgetMs = 500;
    this.strikeWarnThreshold = 50;
  }

  /**
   * Register a client for tracking. Call on join.
   */
  addClient(playerId: PlayerId): void {
    const lifetime = this.parked.get(playerId);
    this.parked.delete(playerId);
    this.clients.set(playerId, {
      timeBudget: this.maxBudgetMs, // Start with full budget (grace period)
      lastInputTime: performance.now(),
      inputsThisTick: 0,
      warpStrikes: lifetime?.warpStrikes ?? 0,
      totalAccepted: lifetime?.totalAccepted ?? 0,
      totalRejected: lifetime?.totalRejected ?? 0,
    });
  }

  /**
   * Stop tracking a client that stops playing for now (spectate, a held seat),
   * keeping its strikes for when it plays again.
   */
  removeClient(playerId: PlayerId): void {
    const state = this.clients.get(playerId);
    if (state) {
      const { warpStrikes, totalAccepted, totalRejected } = state;
      this.parked.set(playerId, { warpStrikes, totalAccepted, totalRejected });
    }
    this.clients.delete(playerId);
  }

  /** Forget a player entirely. Call when they really leave the server. */
  forgetClient(playerId: PlayerId): void {
    this.clients.delete(playerId);
    this.parked.delete(playerId);
  }

  /**
   * Validate whether a client's input should be accepted.
   * Returns false only over the per-tick flood guard; an exhausted time budget
   * records a strike and still accepts.
   *
   * Call this AFTER dedup (seq check) but BEFORE pushing to inputQueue.
   */
  validateInput(playerId: PlayerId): boolean {
    const state = this.clients.get(playerId);
    if (!state) return true; // Unknown client — allow (shouldn't happen)

    const now = performance.now();

    // --- Layer 1: Flood guard ---
    if (state.inputsThisTick >= this.maxInputsPerTick) {
      state.warpStrikes++;
      state.totalRejected++;
      this.logStrike(playerId, state, "rate_cap");
      return false;
    }

    // --- Layer 2: Time budget ---
    const elapsed = now - state.lastInputTime;
    state.lastInputTime = now;

    // Earn time credit for real time that passed, capped at maxBudgetMs so a
    // client can't bank unlimited time by idling.
    state.timeBudget = Math.min(this.maxBudgetMs, state.timeBudget + elapsed);

    // Spend time credit for this input
    if (state.timeBudget < this.inputCostMs) {
      // Not enough budget — client is sending faster than real time
      state.warpStrikes++;
      this.logStrike(playerId, state, "time_budget");
    } else {
      state.timeBudget -= this.inputCostMs;
    }

    state.inputsThisTick++;
    state.totalAccepted++;
    return true;
  }

  /**
   * Reset per-tick counters. Call at the start of each server tick.
   */
  onTick(): void {
    for (const state of this.clients.values()) {
      state.inputsThisTick = 0;
    }
  }

  /**
   * Get the cumulative warp strike count for a client.
   * Gametypes can use this to decide on warnings/kicks.
   */
  getStrikes(playerId: PlayerId): number {
    return (this.clients.get(playerId) ?? this.parked.get(playerId))?.warpStrikes ?? 0;
  }

  /**
   * Get stats for a client (for diagnostics/logging).
   */
  getStats(playerId: PlayerId): { accepted: number; rejected: number; strikes: number } | null {
    const state = this.clients.get(playerId);
    if (!state) return null;
    return {
      accepted: state.totalAccepted,
      rejected: state.totalRejected,
      strikes: state.warpStrikes,
    };
  }

  private logStrike(playerId: PlayerId, state: ClientMovementState, reason: string): void {
    // Log at threshold, then every 100 strikes to avoid spam
    if (
      state.warpStrikes === this.strikeWarnThreshold ||
      (state.warpStrikes > this.strikeWarnThreshold && state.warpStrikes % 100 === 0)
    ) {
      console.warn(
        `[MovementValidator] Player ${playerId}: ${state.warpStrikes} warp strikes ` +
          `(reason: ${reason}, accepted: ${state.totalAccepted}, rejected: ${state.totalRejected})`,
      );
    }
  }
}
