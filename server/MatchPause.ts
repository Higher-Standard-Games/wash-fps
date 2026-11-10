/**
 * MatchPause — timeouts: the whole match held still, then counted back in.
 *
 * A timeout stops the server's loop. Nothing is simulated, so nothing moves,
 * no timer runs and every velocity is exactly as it was when play resumes: a
 * player falling at the moment of the call carries on falling. Chat still
 * works.
 *
 * Each player may call one timeout a match. It lasts until anyone playing calls
 * time in, or for two minutes, and play resumes after a three-second count.
 * The server calls one of its own, which costs nobody theirs, when a player
 * drops out of a head-to-head match.
 *
 * Wall-clock times throughout: the tick count stands still while paused.
 */

import type { PlayerId } from "@engine/server/ecs/types";
import type { MatchPauseNotice, MatchPauseState } from "../../../engine/network/protocol/MessageCodec";

export const TIMEOUT_MS = 120_000;
export const TIMEIN_COUNT_MS = 3_000;

export type TimeoutRefusal = "used" | "paused";

export class MatchPause {
  private _state: MatchPauseState = "running";
  /** When the timeout runs out, or the count ends. */
  private endsAt = 0;
  private caller = "";
  private forDrop = false;
  /** When this pause began, and how long the match has been held in all. */
  private pausedAt = 0;
  private readonly used = new Set<PlayerId>();

  get state(): MatchPauseState {
    return this._state;
  }

  get paused(): boolean {
    return this._state !== "running";
  }

  /** A player's own timeout. They get one a match. */
  callTimeout(playerId: PlayerId, name: string, now: number): TimeoutRefusal | null {
    if (this._state === "timeout") return "paused";
    if (this.used.has(playerId)) return "used";
    this.used.add(playerId);
    this.start(name, false, now);
    return null;
  }

  /** The server's timeout for a player who dropped; it costs them nothing. */
  callForDrop(name: string, now: number): boolean {
    if (this._state === "timeout") return false;
    this.start(name, true, now);
    return true;
  }

  /** Start counting back in. False unless a timeout is holding the match. */
  callTimein(now: number): boolean {
    if (this._state !== "timeout") return false;
    this._state = "timein";
    this.endsAt = now + TIMEIN_COUNT_MS;
    return true;
  }

  /**
   * Move on when time is up: a timeout that runs out counts back in, and a
   * count that ends resumes play. Returns the new state when it changed.
   */
  update(now: number): MatchPauseState | null {
    if (this._state === "running" || now < this.endsAt) return null;
    if (this._state === "timeout") {
      this.callTimein(now);
      return "timein";
    }
    this._state = "running";
    this.endsAt = 0;
    return "running";
  }

  /** How long the match has been held this time; 0 while running. */
  heldFor(now: number): number {
    return this.paused ? now - this.pausedAt : 0;
  }

  notice(now: number): MatchPauseNotice {
    return {
      state: this._state,
      msLeft: this.paused ? Math.max(0, this.endsAt - now) : 0,
      caller: this.caller,
      forDrop: this.forDrop,
    };
  }

  /** A new match: everyone has their timeout back. */
  reset(): void {
    this._state = "running";
    this.endsAt = 0;
    this.caller = "";
    this.forDrop = false;
    this.used.clear();
  }

  private start(caller: string, forDrop: boolean, now: number): void {
    // A timeout called during the count back in holds the match from where it is
    if (this._state === "running") this.pausedAt = now;
    this._state = "timeout";
    this.endsAt = now + TIMEOUT_MS;
    this.caller = caller;
    this.forDrop = forDrop;
  }
}
