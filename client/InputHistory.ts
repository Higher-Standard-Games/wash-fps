/**
 * InputHistory - Stores player inputs for reconciliation replay
 *
 * When the server sends an acknowledged input sequence number,
 * we replay all inputs AFTER that sequence to re-predict our position.
 * Each input also keeps the state prediction reached after running it, so a
 * snapshot can be checked against what was predicted for the same command,
 * and a replay can resume from the state the acknowledged command left.
 */

import type { Vec3 } from "../../../engine/network/components/TransformComponent";
import type { LiftState } from "../../../shared/bsp/LiftSystem";
import type { MovementProfileState } from "../simulation/MovementProfile";

/** Predicted state right after a command ran. */
export interface PredictedStep {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  /** Knockback drag age after the step, or null when no drag is active. */
  knockbackAge: number | null;
  movement: MovementProfileState;
  /** Map movers after the step, on maps that have them. */
  lifts?: LiftState[];
}

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

  /** When the command was generated (performance.now) */
  timestamp: number;

  /** State after the command, from its latest prediction or replay. */
  predicted?: PredictedStep;
}

export class InputHistory {
  private inputs: Map<number, StoredInput> = new Map();
  private nextSeq: number = 1;

  /**
   * Maximum inputs to store: two seconds at 125 Hz, beyond the client's replay
   * budget, and a bound if the server goes silent.
   */
  private static readonly MAX_INPUTS = 256;

  /**
   * Add a new input and return its sequence number
   */
  add(input: Omit<StoredInput, "seq" | "timestamp" | "predicted">): number {
    const seq = this.nextSeq++;

    this.inputs.set(seq, {
      ...input,
      seq,
      timestamp: performance.now(),
    });

    // Insertion order is sequence order, so the first key is the oldest.
    if (this.inputs.size > InputHistory.MAX_INPUTS) {
      const oldest = this.inputs.keys().next().value;
      if (oldest !== undefined) this.inputs.delete(oldest);
    }

    return seq;
  }

  /** Record the state a command's prediction (or replay) reached. */
  setPredicted(seq: number, predicted: PredictedStep): void {
    const input = this.inputs.get(seq);
    if (input) input.predicted = predicted;
  }

  /** The stored input with this sequence, if it is still held. */
  get(seq: number): StoredInput | undefined {
    return this.inputs.get(seq);
  }

  /**
   * Get all inputs with sequence > ackedSeq (unacknowledged)
   * Returns in order (oldest first)
   */
  getUnacked(ackedSeq: number): StoredInput[] {
    const unacked: StoredInput[] = [];
    for (const [seq, input] of this.inputs) {
      if (seq > ackedSeq) unacked.push(input);
    }
    return unacked;
  }

  /**
   * Remove inputs older than the acknowledged one. The acknowledged input
   * itself stays: it holds the state the next replay resumes from, and the next
   * snapshot can acknowledge the same command again.
   */
  pruneAcked(ackedSeq: number): void {
    for (const seq of this.inputs.keys()) {
      if (seq >= ackedSeq) break;
      this.inputs.delete(seq);
    }
  }

  /**
   * Get current sequence number (for next input)
   */
  getCurrentSeq(): number {
    return this.nextSeq;
  }

  /** Number of stored inputs newer than the acknowledged one. */
  countUnacked(ackedSeq: number): number {
    let count = 0;
    for (const seq of this.inputs.keys()) if (seq > ackedSeq) count++;
    return count;
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
