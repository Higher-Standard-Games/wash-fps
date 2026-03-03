/**
 * MovementValidator — Anti-Warp / Speed Hack Prevention
 * 
 * Prevents clients from gaining extra movement by flooding inputs.
 * Uses a combined approach:
 * 
 * 1. **Rate cap**: Hard limit on inputs processed per server tick
 * 2. **Time budget**: Each client earns real-time credit between inputs.
 *    Each accepted input "costs" 1/expectedClientRate seconds.
 *    If the budget goes negative, the input is silently dropped.
 * 
 * Silent drops don't reveal detection to cheaters — they just see
 * their movement stutter when flooding inputs.
 */

import type { PlayerId } from '@engine/server/ecs/types';

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

export class MovementValidator {
    private clients = new Map<PlayerId, ClientMovementState>();

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
        this.maxInputsPerTick = Math.ceil(expectedClientRate / serverTickRate) + 2;
        // Allow banking up to ~200ms of time (handles small network bursts)
        this.maxBudgetMs = 200;
        this.strikeWarnThreshold = 50;
    }

    /**
     * Register a client for tracking. Call on join.
     */
    addClient(playerId: PlayerId): void {
        this.clients.set(playerId, {
            timeBudget: this.maxBudgetMs, // Start with full budget (grace period)
            lastInputTime: performance.now(),
            inputsThisTick: 0,
            warpStrikes: 0,
            totalAccepted: 0,
            totalRejected: 0,
        });
    }

    /**
     * Unregister a client. Call on disconnect.
     */
    removeClient(playerId: PlayerId): void {
        this.clients.delete(playerId);
    }

    /**
     * Validate whether a client's input should be accepted.
     * Returns true if the input passes anti-warp checks.
     * 
     * Call this AFTER dedup (seq check) but BEFORE pushing to inputQueue.
     */
    validateInput(playerId: PlayerId): boolean {
        const state = this.clients.get(playerId);
        if (!state) return true; // Unknown client — allow (shouldn't happen)

        const now = performance.now();

        // --- Layer 1: Rate cap ---
        if (state.inputsThisTick >= this.maxInputsPerTick) {
            state.warpStrikes++;
            state.totalRejected++;
            this.logStrike(playerId, state, 'rate_cap');
            return false;
        }

        // --- Layer 2: Time budget ---
        const elapsed = now - state.lastInputTime;
        state.lastInputTime = now;

        // Earn time credit for real time that passed
        state.timeBudget += elapsed;

        // Cap budget — can't bank unlimited time by idling
        if (state.timeBudget > this.maxBudgetMs) {
            state.timeBudget = this.maxBudgetMs;
        }

        // Spend time credit for this input
        if (state.timeBudget < this.inputCostMs) {
            // Not enough budget — client is sending faster than real time
            state.warpStrikes++;
            state.totalRejected++;
            this.logStrike(playerId, state, 'time_budget');
            return false;
        }

        // Accept: deduct cost
        state.timeBudget -= this.inputCostMs;
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
        return this.clients.get(playerId)?.warpStrikes ?? 0;
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
        if (state.warpStrikes === this.strikeWarnThreshold ||
            (state.warpStrikes > this.strikeWarnThreshold && state.warpStrikes % 100 === 0)) {
            console.warn(
                `[MovementValidator] Player ${playerId}: ${state.warpStrikes} warp strikes ` +
                `(reason: ${reason}, accepted: ${state.totalAccepted}, rejected: ${state.totalRejected})`
            );
        }
    }
}
