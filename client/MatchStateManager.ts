/**
 * MatchStateManager — Client-side match state tracker
 *
 * Consumes 'match_state' events from server snapshots and exposes
 * match phase, timer, and ready status for HUD consumption.
 */

import type {
  BombExplosionEvent,
  BombObjectiveSnapshot,
  MatchWinner,
  ObjectiveSnapshot,
  RoundResult,
} from "../../../shared/server/gametype/GametypeTypes";
// Match types are the shared gametype contract (server-authored). They used to
// be hand-copied here and silently drifted from the server (QA-4: the client
// weakened team records to string and added `spectators`). Import the single
// source and re-export so existing `./MatchStateManager` consumers keep their
// imports.
import { MatchPhase } from "../../../shared/server/gametype/GametypeTypes";

export { MatchPhase };
export type { BombExplosionEvent, BombObjectiveSnapshot, MatchWinner, ObjectiveSnapshot, RoundResult };
export type { MatchStateSnapshot } from "../../../shared/server/gametype/GametypeTypes";

export type PhaseChangeCallback = (newPhase: MatchPhase, oldPhase: MatchPhase) => void;

export class MatchStateManager {
  private static instance: MatchStateManager | null = null;

  private _phase: MatchPhase = MatchPhase.Warmup;
  private _timeRemaining: number = 0;
  private _readyCount: number = 0;
  private _totalPlayers: number = 0;
  private _gametypeName: string = "";
  private _teamBased: boolean = false;
  private _scoreLimit: number = 0;
  private _teamScores: Record<string, number> = {};
  private _playerTeams: Record<string, string> = {};
  private _teamNames: Record<string, string> = {};
  private _spectators: Array<{ playerId: string; name: string; ping: number }> = [];
  private _standings: Array<{ playerId: string; name: string; score: number; deaths: number; ping: number }> = [];
  private _winner: MatchWinner | null = null;
  private _overtime: number = 0;
  private _flow: "single" | "continuous" = "continuous";
  private _round: number = 0;
  private _teamRoles: Record<string, string> = {};
  private _roundState: string | null = null;
  private _objective: ObjectiveSnapshot | null = null;
  private _roundResult: RoundResult | null = null;
  private _explosion: BombExplosionEvent | null = null;
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
    this._teamBased = event.teamBased ?? false;
    this._scoreLimit = event.scoreLimit ?? 0;
    this._teamScores = event.teamScores ?? {};
    this._playerTeams = event.playerTeams ?? {};
    this._teamNames = event.teamNames ?? {};
    // The server leaves the roster out once we hold it, and says so. Without
    // that marker a missing list means an empty one.
    if (event.rosterOmitted !== true) {
      this._spectators = event.spectators ?? [];
      this._standings = event.standings ?? [];
    }
    // Parse winner BEFORE firing phase callbacks so PostGame subscribers see it.
    this._winner = event.winner ?? null;
    this._overtime = event.overtime ?? 0;
    this._flow = event.flow ?? "continuous";
    this._round = event.round ?? 0;
    this._teamRoles = event.teamRoles ?? {};
    this._roundState = event.roundState ?? null;
    this._objective = event.objective ?? null;
    this._roundResult = event.roundResult ?? null;
    this._explosion = event.explosion ?? null;

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

  /** Whether this gametype divides players into teams (server-authoritative). */
  get teamBased(): boolean {
    return this._teamBased;
  }
  /** Whether joining this mode must first collect a round loadout. */
  get requiresLoadoutSelection(): boolean {
    const mode = this._gametypeName.trim().toLowerCase();
    return mode === "search & destroy" || mode === "amphi";
  }
  get scoreLimit(): number {
    return this._scoreLimit;
  }
  /** Current round, 1-based. 0 in modes that are not round-based. */
  get round(): number {
    return this._round;
  }
  /** "attacker" / "defender" per team id, in round modes. */
  get teamRoles(): Record<string, string> {
    return this._teamRoles;
  }
  /** "pre_plant" / "post_plant" — what the round is currently about. */
  get roundState(): string | null {
    return this._roundState;
  }
  /** The mode's objective, or null. Narrow on `kind` before reading it. */
  get objective(): ObjectiveSnapshot | null {
    return this._objective;
  }
  /** How the last round ended. Set only during the round-end intermission. */
  get roundResult(): RoundResult | null {
    return this._roundResult;
  }
  /**
   * A detonation to play out. Repeated for about a second after it fires, so
   * consumers must recognise a repeat rather than replaying it.
   */
  get explosion(): BombExplosionEvent | null {
    return this._explosion;
  }
  /** The bomb, when there is one. Null in every other mode. */
  get bomb(): BombObjectiveSnapshot | null {
    return this._objective?.kind === "bomb" ? this._objective : null;
  }
  /** True when this player's team is attacking this round. */
  isAttacking(teamId: string | undefined): boolean {
    return !!teamId && this._teamRoles[teamId] === "attacker";
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

  /** Final standings from the match tally — valid after entities are gone. */
  get standings(): Array<{ playerId: string; name: string; score: number; deaths: number; ping: number }> {
    return this._standings;
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
   * True while the server is zeroing everyone's movement and action input.
   *
   * Mirrors `GametypeController.applyPostGameInputFreeze` exactly, and has to:
   * the client predicts its own movement, so a freeze the client does not know
   * about is one it walks straight through and gets snapped back out of. That
   * rubber-band at the top of every round is the whole symptom.
   *
   * Round modes freeze during the Countdown — that is the "get ready" phase,
   * with everyone stood at their spawn — and during the round-end result, and
   * every mode freezes for the post-game screen. A non-round mode's countdown
   * is the pre-match one, which does NOT hold players still.
   */
  isMovementFrozen(): boolean {
    if (this._phase === MatchPhase.PostGame) return true;
    // `round > 0` is what makes this a round mode, the same signal the rest of
    // the client uses. A deathmatch never sets it.
    const roundBased = this._round > 0;
    if (!roundBased) return false;
    return this._phase === MatchPhase.RoundEnd || this._phase === MatchPhase.Countdown;
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
      case MatchPhase.RoundEnd:
        return "Round Over";
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
    this._teamBased = false;
    this._scoreLimit = 0;
    this._isReady = false;
    // Rosters describe the match that just ended, so they cannot outlive it.
    // Left behind, the next match's result screen opens showing the previous
    // one's names and scores until the first snapshot replaces them.
    this._spectators = [];
    this._standings = [];
  }

  static destroy(): void {
    MatchStateManager.instance?.reset();
    MatchStateManager.instance = null;
  }
}
