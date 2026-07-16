/**
 * ServerTiming — the single timing contract for a game server (QA-24 / QA-WO12).
 *
 * Everything time-based derives from one immutable value built once from the
 * server config: the simulation tick, the snapshot cadence, and lifecycle
 * durations. Before this existed the pieces were scattered — every subsystem
 * hardcoded `tickRate: 125`, post-game timers were `10 * 125`-style literals,
 * and demo metadata recorded the *requested* snapshot rate even when rounding
 * made the effective rate different (125/60 broadcasts every 2 ticks = 62.5Hz;
 * recording "60" made nominal demo playback ~4.17% slow).
 *
 * Snapshot cadence is an integer tick divisor, so the effective rate is
 * `tickRate / ticksPerSnapshot` — record and log THAT, never an unattained
 * requested rate.
 */

export interface ServerTiming {
  /** Base simulation rate in Hz. */
  readonly tickRate: number;
  /** Duration of one tick in milliseconds. */
  readonly tickMs: number;
  /** Duration of one tick in seconds (the subsystem dt). */
  readonly tickDt: number;
  /** Snapshot rate the config asked for. */
  readonly requestedSnapshotRate: number;
  /** Broadcast every N simulation ticks (integer ≥ 1). */
  readonly ticksPerSnapshot: number;
  /** The rate snapshots are actually sent at: tickRate / ticksPerSnapshot. */
  readonly effectiveSnapshotRate: number;
  /** Ticks into a terminal post-game when bots are released (10s). */
  readonly postGameBotKickTicks: number;
  /** Ticks into a terminal post-game when remaining clients are closed (120s). */
  readonly postGameGraceTicks: number;
}

/** Convert a wall-clock duration to a whole number of simulation ticks. */
export function secondsToTicks(seconds: number, tickRate: number): number {
  return Math.round(seconds * tickRate);
}

const POSTGAME_BOT_KICK_SECONDS = 10;
const POSTGAME_GRACE_SECONDS = 120;

/**
 * Build the timing contract from server config. Throws on unrepresentable
 * configs (non-positive or fractional rates, snapshot rate above tick rate);
 * warns when integer rounding makes the effective snapshot rate differ from
 * the requested one.
 */
export function createServerTiming(config: { tickRate: number; snapshotRate?: number }): ServerTiming {
  const { tickRate } = config;
  if (!Number.isInteger(tickRate) || tickRate <= 0) {
    throw new Error(`[ServerTiming] tickRate must be a positive integer, got ${tickRate}`);
  }

  const requestedSnapshotRate = config.snapshotRate ?? 60;
  if (!(requestedSnapshotRate > 0)) {
    throw new Error(`[ServerTiming] snapshotRate must be > 0, got ${requestedSnapshotRate}`);
  }
  if (requestedSnapshotRate > tickRate) {
    throw new Error(
      `[ServerTiming] snapshotRate (${requestedSnapshotRate}) cannot exceed tickRate (${tickRate}) — snapshots are sent on tick boundaries`,
    );
  }

  const ticksPerSnapshot = Math.max(1, Math.round(tickRate / requestedSnapshotRate));
  const effectiveSnapshotRate = tickRate / ticksPerSnapshot;
  if (effectiveSnapshotRate !== requestedSnapshotRate) {
    console.warn(
      `[ServerTiming] snapshot rate ${requestedSnapshotRate}Hz is not an integer divisor of ${tickRate}Hz — ` +
        `broadcasting every ${ticksPerSnapshot} ticks = ${effectiveSnapshotRate}Hz (the effective rate is what gets logged and recorded)`,
    );
  }

  return Object.freeze({
    tickRate,
    tickMs: 1000 / tickRate,
    tickDt: 1 / tickRate,
    requestedSnapshotRate,
    ticksPerSnapshot,
    effectiveSnapshotRate,
    postGameBotKickTicks: secondsToTicks(POSTGAME_BOT_KICK_SECONDS, tickRate),
    postGameGraceTicks: secondsToTicks(POSTGAME_GRACE_SECONDS, tickRate),
  });
}
