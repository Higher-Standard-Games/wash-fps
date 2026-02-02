/**
 * InputHistory - Stores player inputs for reconciliation replay
 * 
 * When the server sends an acknowledged input sequence number,
 * we replay all inputs AFTER that sequence to re-predict our position.
 */

import type { Vec3 } from '../../../engine/network/components/TransformComponent';

export interface StoredInput {
    /** Sequence number (incrementing) */
    seq: number;

    /** World-space wish direction (pre-rotated) */
    direction: Vec3;

    /** View angles */
    pitch: number;
    yaw: number;

    /** Button bitmask */
    buttons: number;

    /** Client tick when input was generated */
    clientTick: number;

    /** Timestamp for debugging */
    timestamp: number;
}

export class InputHistory {
    private inputs: Map<number, StoredInput> = new Map();
    private nextSeq: number = 1;

    /** Maximum inputs to store (prevents memory leak if server goes silent) */
    private static readonly MAX_INPUTS = 256;

    /**
     * Add a new input and return its sequence number
     */
    add(input: Omit<StoredInput, 'seq' | 'timestamp'>): number {
        const seq = this.nextSeq++;

        this.inputs.set(seq, {
            ...input,
            seq,
            timestamp: performance.now(),
        });

        // Prune old inputs if too many
        if (this.inputs.size > InputHistory.MAX_INPUTS) {
            const oldest = Math.min(...this.inputs.keys());
            this.inputs.delete(oldest);
        }

        return seq;
    }

    /**
     * Get all inputs with sequence > ackedSeq (unacknowledged)
     * Returns in order (oldest first)
     */
    getUnacked(ackedSeq: number): StoredInput[] {
        const unacked: StoredInput[] = [];

        for (const [seq, input] of this.inputs) {
            if (seq > ackedSeq) {
                unacked.push(input);
            }
        }

        // Sort by sequence (oldest first)
        unacked.sort((a, b) => a.seq - b.seq);

        return unacked;
    }

    /**
     * Remove all inputs with sequence <= ackedSeq
     */
    pruneAcked(ackedSeq: number): void {
        for (const seq of this.inputs.keys()) {
            if (seq <= ackedSeq) {
                this.inputs.delete(seq);
            }
        }
    }

    /**
     * Get current sequence number (for next input)
     */
    getCurrentSeq(): number {
        return this.nextSeq;
    }

    /**
     * Get count of stored inputs (for debugging)
     */
    getCount(): number {
        return this.inputs.size;
    }

    /**
     * Clear all inputs (e.g., on respawn)
     */
    clear(): void {
        this.inputs.clear();
    }
}
