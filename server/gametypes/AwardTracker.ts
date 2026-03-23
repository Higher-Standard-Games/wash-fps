/**
 * AwardTracker — Server-side award/achievement tracking
 *
 * Tracks per-player kill streaks and emits award events that get
 * serialized to clients via the snapshot event pipeline.
 *
 * Also exposes a `customAward()` API that gametype scripts can use
 * to emit arbitrary awards (e.g. "Flag Captured!", "Checkpoint!").
 *
 * Flow:
 *   GametypeController.postTick() → awardTracker.onKill() / onDeath()
 *   → returns AwardEvent[] → SnapshotBuilder emits as type: 'award'
 */

import type { PlayerId } from '@engine/server/ecs/types';

// ============================================================================
// Award Event (wire format — sent to all clients)
// ============================================================================

export interface AwardEvent {
    /** Award identifier (built-in or custom) */
    awardType: string;
    /** Player who earned the award */
    playerId: PlayerId;
    /** Display name of the award recipient */
    playerName: string;
    /** Victim name (for frag awards) */
    targetName: string;
    /** Numeric value (streak count, score, etc.) */
    value: number;
}

// ============================================================================
// Built-in award types
// ============================================================================

export const AWARD_FRAG = 'frag';
export const AWARD_FIRST_BLOOD = 'first_blood';
export const AWARD_ON_FIRE = 'on_fire';
export const AWARD_RAGING = 'raging';
export const AWARD_UNSTOPPABLE = 'unstoppable';

/** Kill streak thresholds → award type */
const STREAK_THRESHOLDS: [number, string][] = [
    [20, AWARD_UNSTOPPABLE],
    [10, AWARD_RAGING],
    [5, AWARD_ON_FIRE],
];

// ============================================================================
// Per-Player State
// ============================================================================

interface PlayerState {
    killStreak: number;
    /** Track which streak awards were already given (avoid re-firing) */
    awardedStreaks: Set<string>;
}

// ============================================================================
// AwardTracker
// ============================================================================

export class AwardTracker {
    private players = new Map<PlayerId, PlayerState>();
    private firstBloodClaimed = false;

    /** Pending awards to be drained by SnapshotBuilder */
    private pending: AwardEvent[] = [];

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /** Reset all state on match start */
    onMatchStart(): void {
        this.players.clear();
        this.firstBloodClaimed = false;
        this.pending = [];
    }

    /** Ensure player has tracking state */
    ensurePlayer(playerId: PlayerId): void {
        if (!this.players.has(playerId)) {
            this.players.set(playerId, {
                killStreak: 0,
                awardedStreaks: new Set(),
            });
        }
    }

    // ========================================================================
    // Kill / Death Processing
    // ========================================================================

    /**
     * Called when a player kills another player.
     * Returns generated award events.
     */
    onKill(killerId: PlayerId, victimId: PlayerId, killerName: string, victimName: string): void {
        // Skip suicides
        if (killerId === victimId) return;

        this.ensurePlayer(killerId);
        const state = this.players.get(killerId)!;

        // Frag notification (personal, always)
        this.pending.push({
            awardType: AWARD_FRAG,
            playerId: killerId,
            playerName: killerName,
            targetName: victimName,
            value: 0,
        });

        // First blood
        if (!this.firstBloodClaimed) {
            this.firstBloodClaimed = true;
            this.pending.push({
                awardType: AWARD_FIRST_BLOOD,
                playerId: killerId,
                playerName: killerName,
                targetName: '',
                value: 1,
            });
        }

        // Increment kill streak
        state.killStreak++;

        // Check streak thresholds (highest first)
        for (const [threshold, awardType] of STREAK_THRESHOLDS) {
            if (state.killStreak >= threshold && !state.awardedStreaks.has(awardType)) {
                state.awardedStreaks.add(awardType);
                this.pending.push({
                    awardType,
                    playerId: killerId,
                    playerName: killerName,
                    targetName: '',
                    value: state.killStreak,
                });
                break; // Only emit the highest new threshold per kill
            }
        }
    }

    /**
     * Called when a player dies. Resets their kill streak.
     */
    onDeath(playerId: PlayerId): void {
        const state = this.players.get(playerId);
        if (state) {
            state.killStreak = 0;
            state.awardedStreaks.clear();
        }
    }

    // ========================================================================
    // Custom Award API (for gametype scripts)
    // ========================================================================

    /**
     * Emit a custom award from a gametype script.
     * @param awardType - Unique string identifier (e.g. 'flag_capture', 'checkpoint')
     * @param playerId - Player who earned the award
     * @param playerName - Display name of the player
     * @param value - Optional numeric value (score, time, etc.)
     */
    emitAward(awardType: string, playerId: PlayerId, playerName: string, value: number = 0): void {
        this.pending.push({
            awardType,
            playerId,
            playerName,
            targetName: '',
            value,
        });
    }

    // ========================================================================
    // Drain (called by SnapshotBuilder)
    // ========================================================================

    /**
     * Drain pending awards. Returns accumulated awards and clears the buffer.
     */
    drainAwards(): AwardEvent[] {
        if (this.pending.length === 0) return [];
        const awards = this.pending;
        this.pending = [];
        return awards;
    }

    /** Get current kill streak for a player */
    getKillStreak(playerId: PlayerId): number {
        return this.players.get(playerId)?.killStreak ?? 0;
    }
}
