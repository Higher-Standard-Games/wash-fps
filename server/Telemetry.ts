/**
 * Per-client server-side telemetry (WO-12).
 *
 * The substrate the netcode-quality work (WO-10 jitter buffer, WO-11 adaptive
 * redundancy) and the future statistical anti-cheat (WO-13) + demo-replay review
 * all read. Everything here is derived from data the server ALREADY receives —
 * usercmd arrival time, sequence numbers, and view angles — so it adds no wire
 * data. It touches no simulation state and uses wall-clock time, so it has zero
 * effect on tick-loop determinism (it lives in the message handlers + a periodic
 * diagnostic log, which `server:fuzz` doesn't exercise).
 *
 * Metrics per client:
 *  - jitterMs        — RFC3550-style smoothed variance of usercmd inter-arrival.
 *  - inputLoss       — fraction of usercmds never received (seq gaps beyond the
 *                      client's command redundancy), 0..1, cumulative.
 *  - viewSpeedDps    — EWMA of view angular speed (deg/s) between usercmds; the
 *                      aim-flick signal WO-13 keys off.
 *  - peakViewSpeedDps— largest single-sample angular speed seen.
 *
 * Anti-warp strikes are NOT stored here — they live in MovementValidator; the
 * caller composes both at log time (keeps this module a pure function of the
 * usercmd stream and independently testable).
 */

import type { PlayerId } from "@engine/server/ecs/types";

/** Smoothing for the view-speed EWMA (~10-sample memory). */
const VIEW_EWMA_ALPHA = 0.1;
/** RFC3550 jitter gain (1/16). */
const JITTER_GAIN = 1 / 16;
const RAD_TO_DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

/** A point-in-time read of a client's derived metrics. */
export interface ClientMetrics {
  jitterMs: number;
  inputLoss: number;
  viewSpeedDps: number;
  peakViewSpeedDps: number;
  /** usercmds actually observed by the server. */
  inputs: number;
  /** usercmds rejected outright (non-finite dir/pitch/yaw) — a hard contract
   *  violation an honest client never produces (WO-AC2). */
  rejectedCmds: number;
  /** usercmds the sanitizer had to clamp (pitch beyond ±90° or |wishdir|>1) —
   *  also a contract violation; honest clients stay in range (WO-AC2). */
  clampedCmds: number;
}

interface ClientState {
  lastArrivalMs: number | null;
  lastInterArrivalMs: number | null;
  lastSeq: number | null;
  firstSeq: number | null;
  lastPitch: number;
  lastYaw: number;
  jitterMs: number;
  viewSpeedDps: number;
  peakViewSpeedDps: number;
  /** count of usercmds recorded (unique forward-progress seqs). */
  received: number;
  rejectedCmds: number;
  clampedCmds: number;
}

/** Shortest angular distance between two angles (radians), in degrees. */
export function angularDeltaDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % TWO_PI;
  if (d > Math.PI) d = TWO_PI - d;
  return d * RAD_TO_DEG;
}

/** RFC3550 interarrival jitter update: J += (|D| - J) * gain. */
export function updateJitter(prevJitter: number, interArrivalMs: number, lastInterArrivalMs: number): number {
  const d = Math.abs(interArrivalMs - lastInterArrivalMs);
  return prevJitter + (d - prevJitter) * JITTER_GAIN;
}

export class Telemetry {
  private clients = new Map<PlayerId, ClientState>();

  /** Start tracking a client (on join). Idempotent. */
  add(playerId: PlayerId): void {
    if (this.clients.has(playerId)) return;
    this.clients.set(playerId, {
      lastArrivalMs: null,
      lastInterArrivalMs: null,
      lastSeq: null,
      firstSeq: null,
      lastPitch: 0,
      lastYaw: 0,
      jitterMs: 0,
      viewSpeedDps: 0,
      peakViewSpeedDps: 0,
      received: 0,
      rejectedCmds: 0,
      clampedCmds: 0,
    });
  }

  /** Stop tracking a client (on disconnect). */
  remove(playerId: PlayerId): void {
    this.clients.delete(playerId);
  }

  /**
   * Record an input-contract violation (WO-AC2): a usercmd the sanitizer rejected
   * ("rejected", non-finite) or had to clamp ("clamped", out-of-range). Honest
   * clients essentially never trip these, so a nonzero count is a near-zero-FP
   * signal — but still only ever *one input to a score*, never a solo verdict (§0.3).
   */
  recordViolation(playerId: PlayerId, kind: "rejected" | "clamped"): void {
    const s = this.clients.get(playerId);
    if (!s) return;
    if (kind === "rejected") s.rejectedCmds++;
    else s.clampedCmds++;
  }

  /**
   * Record one ACCEPTED usercmd (call after dedup, so `seq` is strictly
   * increasing). `nowMs` is wall-clock arrival time; `pitch`/`yaw` are the
   * sanitized view angles in radians.
   */
  recordInput(playerId: PlayerId, nowMs: number, seq: number, pitch: number, yaw: number): void {
    const s = this.clients.get(playerId);
    if (!s) return;

    s.received++;
    if (s.firstSeq === null) s.firstSeq = seq;

    if (s.lastArrivalMs !== null) {
      const interArrival = nowMs - s.lastArrivalMs;

      // Jitter: needs a previous inter-arrival to diff against.
      if (s.lastInterArrivalMs !== null) {
        s.jitterMs = updateJitter(s.jitterMs, interArrival, s.lastInterArrivalMs);
      }
      s.lastInterArrivalMs = interArrival;

      // View angular speed (deg/s) over the real elapsed time between usercmds.
      const dtSec = interArrival / 1000;
      if (dtSec > 0) {
        const dPitchDeg = Math.abs(pitch - s.lastPitch) * RAD_TO_DEG;
        const dYawDeg = angularDeltaDeg(yaw, s.lastYaw);
        const speed = Math.hypot(dPitchDeg, dYawDeg) / dtSec;
        s.viewSpeedDps = s.viewSpeedDps + (speed - s.viewSpeedDps) * VIEW_EWMA_ALPHA;
        if (speed > s.peakViewSpeedDps) s.peakViewSpeedDps = speed;
      }
    }

    s.lastArrivalMs = nowMs;
    s.lastSeq = seq;
    s.lastPitch = pitch;
    s.lastYaw = yaw;
  }

  /** Read a client's current metrics, or null if untracked. */
  get(playerId: PlayerId): ClientMetrics | null {
    const s = this.clients.get(playerId);
    if (!s) return null;

    // Loss = fraction of the seq span that never arrived. The client resends
    // recent commands (redundancy), so a gap here is genuine unrecovered loss.
    let inputLoss = 0;
    if (s.firstSeq !== null && s.lastSeq !== null) {
      const span = s.lastSeq - s.firstSeq + 1;
      if (span > 0) inputLoss = Math.max(0, 1 - s.received / span);
    }

    return {
      jitterMs: s.jitterMs,
      inputLoss,
      viewSpeedDps: s.viewSpeedDps,
      peakViewSpeedDps: s.peakViewSpeedDps,
      inputs: s.received,
      rejectedCmds: s.rejectedCmds,
      clampedCmds: s.clampedCmds,
    };
  }
}
