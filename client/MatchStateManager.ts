/**
 * MatchStateManager — Client-side match state tracker
 *
 * Consumes 'match_state' events from server snapshots and exposes
 * match phase, timer, and ready status for HUD consumption.
 */

// Match types are the shared gametype contract (server-authored). They used to
// be hand-copied here and silently drifted from the server (QA-4: the client
// weakened team records to string and added `spectators`). Import the single
// source and re-export so existing `./MatchStateManager` consumers keep their
// imports.
import { MatchPhase } from "../../../shared/server/gametype/GametypeTypes";
import type { MatchWinner } from "../../../shared/server/gametype/GametypeTypes";

export { MatchPhase };
export type { MatchWinner };
export type { MatchStateSnapshot } from "../../../shared/server/gametype/GametypeTypes";

export type PhaseChangeCallback = (newPhase: MatchPhase, oldPhase: MatchPhase) => void;

export class MatchStateManager {
  private static instance: MatchStateManager | null = null;

  private _phase: MatchPhase = MatchPhase.Warmup;
  private _timeRemaining: number = 0;
  private _readyCount: number = 0;
  private _totalPlayers: number = 0;
  private _gametypeName: string = "";
  private _scoreLimit: number = 0;
  private _teamScores: Record<string, number> = {};
  private _playerTeams: Record<string, string> = {};
  private _teamNames: Record<string, string> = {};
  private _spectators: Array<{ playerId: string; name: string; ping: number }> = [];
  private _winner: MatchWinner | null = null;
  private _overtime: number = 0;
  private _flow: "single" | "continuous" = "continuous";
  private _isReady: boolean = false;
  private _phaseCallbacks: PhaseChangeCallback[] = [];

  static getInstance(): MatchStateManager {
    if (!MatchStateManager.instance) {
      MatchStateManager.instance = new MatchStateManager();
    }
    return MatchStateManager.instance;
  }

  // ========================================================================
  // Event Processing
  // ========================================================================

  /**
   * Process a match_state event from snapshot.
   * Called by Game when it receives state updates.
   */
  processEvent(event: any): void {
    if (event.type !== "match_state") return;

    const oldPhase = this._phase;
    this._phase = event.phase ?? MatchPhase.Warmup;
    this._timeRemaining = event.timeRemaining ?? 0;
    this._readyCount = event.readyCount ?? 0;
    this._totalPlayers = event.totalPlayers ?? 0;
    this._gametypeName = event.gametypeName ?? "";
    this._scoreLimit = event.scoreLimit ?? 0;
    this._teamScores = event.teamScores ?? {};
    this._playerTeams = event.playerTeams ?? {};
    this._teamNames = event.teamNames ?? {};
    this._spectators = event.spectators ?? [];
    // Parse winner BEFORE firing phase callbacks so PostGame subscribers see it.
    this._winner = event.winner ?? null;
    this._overtime = event.overtime ?? 0;
    this._flow = event.flow ?? "continuous";

    // Fire phase change callbacks
    if (oldPhase !== this._phase) {
      console.log(`[MatchState] Phase changed: ${MatchPhase[oldPhase]} → ${MatchPhase[this._phase]}`);
      for (const cb of this._phaseCallbacks) {
        try {
          cb(this._phase, oldPhase);
        } catch (e) {
          console.error("[MatchState] Phase callback error:", e);
        }
      }
    }
  }

  // ========================================================================
  // Accessors
  // ========================================================================

  get phase(): MatchPhase {
    return this._phase;
  }
  get timeRemaining(): number {
    return this._timeRemaining;
  }
  get readyCount(): number {
    return this._readyCount;
  }
  get totalPlayers(): number {
    return this._totalPlayers;
  }
  get gametypeName(): string {
    return this._gametypeName;
  }
  get scoreLimit(): number {
    return this._scoreLimit;
  }
  get teamScores(): Record<string, number> {
    return this._teamScores;
  }
  get playerTeams(): Record<string, string> {
    return this._playerTeams;
  }
  get teamNames(): Record<string, string> {
    return this._teamNames;
  }
  /** Spectator roster (no sim entity) — for the scoreboard. */
  get spectators(): Array<{ playerId: string; name: string; ping: number }> {
    return this._spectators;
  }
  /** Match result — set only while in PostGame. */
  get winner(): MatchWinner | null {
    return this._winner;
  }
  /** Overtime extensions this match (0 = regulation). */
  get overtime(): number {
    return this._overtime;
  }
  /** Match flow mode — "single" post-games are terminal (return to lobby). */
  get flow(): "single" | "continuous" {
    return this._flow;
  }

  /**
   * Resolve the winning PLAYER id (bare, e.g. "3"), or null for draws/none.
   * Duel reports a team win (it rides the team infrastructure with one player
   * per side) — a single-member winning team maps to its player. Multi-member
   * team wins return null (TDM MVP selection comes with proper stats).
   */
  resolveWinnerPlayerId(): string | null {
    const winner = this._winner;
    if (!winner || winner.kind === "draw" || !winner.id) return null;
    if (winner.kind === "player") return winner.id;
    const members = Object.entries(this._playerTeams)
      .filter(([, teamId]) => teamId === winner.id)
      .map(([playerId]) => playerId);
    return members.length === 1 ? members[0] : null;
  }
  get isReady(): boolean {
    return this._isReady;
  }

  isWarmup(): boolean {
    return this._phase === MatchPhase.Warmup;
  }
  isCountdown(): boolean {
    return this._phase === MatchPhase.Countdown;
  }
  isActive(): boolean {
    return this._phase === MatchPhase.Active;
  }
  isPostGame(): boolean {
    return this._phase === MatchPhase.PostGame;
  }

  /**
   * Get time as mm:ss string
   */
  getTimeString(): string {
    const total = Math.max(0, Math.ceil(this._timeRemaining));
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
  }

  /**
   * Get countdown number (3, 2, 1) during countdown phase
   */
  getCountdownNumber(): number {
    if (this._phase !== MatchPhase.Countdown) return 0;
    return Math.ceil(this._timeRemaining);
  }

  /**
   * Get ready status string
   */
  getReadyStatus(): string {
    return `${this._readyCount}/${this._totalPlayers} Ready`;
  }

  /**
   * Get phase display name
   */
  getPhaseName(): string {
    switch (this._phase) {
      case MatchPhase.Warmup:
        return "Warmup";
      case MatchPhase.Countdown:
        return "Starting";
      case MatchPhase.Active:
        return "Active";
      case MatchPhase.PostGame:
        return "Match Over";
    }
  }

  // ========================================================================
  // Ready State
  // ========================================================================

  setReady(ready: boolean): void {
    this._isReady = ready;
  }

  // ========================================================================
  // Callbacks
  // ========================================================================

  onPhaseChange(callback: PhaseChangeCallback): () => void {
    this._phaseCallbacks.push(callback);
    return () => {
      const idx = this._phaseCallbacks.indexOf(callback);
      if (idx >= 0) this._phaseCallbacks.splice(idx, 1);
    };
  }

  // ========================================================================
  // Cleanup
  // ========================================================================

  reset(): void {
    this._phase = MatchPhase.Warmup;
    this._timeRemaining = 0;
    this._readyCount = 0;
    this._totalPlayers = 0;
    this._gametypeName = "";
    this._scoreLimit = 0;
    this._isReady = false;
  }

  static destroy(): void {
    MatchStateManager.instance?.reset();
    MatchStateManager.instance = null;
  }
}
