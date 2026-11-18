/**
 * FairPlayLedger — one match's fair-play counters per account, for the lobby.
 *
 * The counters already exist, each beside the ground truth it counts:
 * Telemetry (per connection: impossible inputs, the view-speed histogram),
 * WeaponSystem (per entity: hitscan shots, hits, headshots), the movement
 * subsystem (per entity: tripwire) and MovementValidator (per player: warp
 * strikes). Each is lost when its owner forgets the client, so GameServer
 * folds them in here first, and at the end of the match sends the totals once
 * (FairPlayReport). Aggregates only: nothing per command or per tick.
 *
 * Collected always, on every lobby match; nothing reads them during the match
 * and nothing acts on them automatically (ANTICHEAT_FEATURES.md §0.3).
 */
import type { FairPlayAccount } from "../../../engine/server/network/FairPlayReport";
import type { ClientMetrics } from "./Telemetry";

type Counters = Record<string, number>;

export class FairPlayLedger {
  private readonly accounts = new Map<number, Counters>();
  /** Warp strikes are a lifetime count per player id, so they are kept as the newest read, not summed. */
  private readonly strikes = new Map<number, Map<number, number>>();

  private counters(accountId: number): Counters {
    let counters = this.accounts.get(accountId);
    if (!counters) {
      counters = {};
      this.accounts.set(accountId, counters);
    }
    return counters;
  }

  private add(accountId: number, name: string, value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    const counters = this.counters(accountId);
    counters[name] = (counters[name] ?? 0) + Math.round(value);
  }

  /** A connection's Telemetry, read just before it is removed. */
  foldTelemetry(accountId: number, metrics: ClientMetrics | null): void {
    if (!metrics) return;
    this.counters(accountId);
    this.add(accountId, "inputs", metrics.inputs);
    this.add(accountId, "rejectedCmds", metrics.rejectedCmds);
    this.add(accountId, "clampedCmds", metrics.clampedCmds);
    this.add(accountId, "backtrackCmds", metrics.backtrackCmds);
    this.add(accountId, "assistedCmds", metrics.assistedShare * metrics.inputs);
    this.add(accountId, "assistedSwitches", metrics.assistedSwitches);
    metrics.flickHistogram.forEach((count, bucket) => {
      this.add(accountId, `flick${bucket}`, count);
    });
    const counters = this.counters(accountId);
    counters.peakViewSpeedDps = Math.max(counters.peakViewSpeedDps ?? 0, Math.round(metrics.peakViewSpeedDps));
  }

  /** An entity's hitscan accuracy and tripwire count, read before the entity is forgotten. */
  foldEntity(accountId: number, accuracy: { shots: number; hits: number; headshots: number }, tripwire: number): void {
    this.add(accountId, "shots", accuracy.shots);
    this.add(accountId, "hits", accuracy.hits);
    this.add(accountId, "headshots", accuracy.headshots);
    this.add(accountId, "tripwireHits", tripwire);
  }

  /** A player id's lifetime warp strikes as MovementValidator holds them now. */
  noteStrikes(accountId: number, playerId: number, strikes: number): void {
    this.counters(accountId);
    let byPlayer = this.strikes.get(accountId);
    if (!byPlayer) {
      byPlayer = new Map();
      this.strikes.set(accountId, byPlayer);
    }
    byPlayer.set(playerId, Math.max(byPlayer.get(playerId) ?? 0, strikes));
  }

  /** Every account's totals, in the order they first appeared. */
  report(): FairPlayAccount[] {
    return [...this.accounts].map(([accountId, counters]) => {
      const signals: Counters = { ...counters };
      const warp = [...(this.strikes.get(accountId)?.values() ?? [])].reduce((sum, n) => sum + n, 0);
      if (warp > 0) signals.warpStrikes = warp;
      return { accountId, signals };
    });
  }
}
