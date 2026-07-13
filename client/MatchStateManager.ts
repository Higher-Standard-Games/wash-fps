/**
 * MatchStateManager — Client-side match state tracker
 *
 * Consumes 'match_state' events from server snapshots and exposes
 * match phase, timer, and ready status for HUD consumption.
 */

// Match phases must mirror shared/server/gametype/GametypeTypes.ts
export enum MatchPhase {
  Warmup = 0,
  Countdown = 1,
  Active = 2,
  PostGame = 3,
}

/** Authoritative match result (set by the server during PostGame). */
export interface MatchWinner {
  kind: "player" | "team" | "draw";
  id?: string;
  name?: string;
}

export interface MatchStateSnapshot {
  phase: MatchPhase;
  timeRemaining: number;
  readyCount: number;
  totalPlayers: number;
  gametypeName: string;
  scoreLimit: number;
  teamScores?: Record<string, number>;
  playerTeams?: Record<string, string>;
  teamNames?: Record<string, string>;
  spectators?: Array<{ playerId: string; name: string; ping: number }>;
  winner?: MatchWinner;
}

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
