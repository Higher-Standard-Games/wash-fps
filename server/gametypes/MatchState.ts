/**
 * Match State Machine
 *
 * Manages match lifecycle: Warmup → Countdown → Active → PostGame
 * Follows Quake/Warsow convention for competitive FPS.
 */

import type { PlayerId } from "@engine/server/ecs/types";
import {
  type MatchConfig,
  MatchPhase,
  type MatchStateSnapshot,
  type MatchWinner,
  type TeamId,
} from "@shared/server/gametype";

/**
 * Default match config (can be overridden by gametype)
 */
const DEFAULT_MATCH_CONFIG: MatchConfig = {
  warmupTimeout: 120, // 2 minutes
  countdownDuration: 3, // 3-2-1
  scoreLimit: 20,
  timeLimit: 600, // 10 minutes
  postGameDuration: 15, // post-game screen (winner banner + scoreboard)
  respawnDelay: 3, // 3 seconds
  selfDamage: 1.0, // full self-damage (rocket jumping!)
};

export class MatchState {
  private _phase: MatchPhase = MatchPhase.Warmup;
  private _timeRemaining: number;
  private _readyPlayers: Set<PlayerId> = new Set();
  private _totalPlayers: number = 0;
  private _scores: Map<PlayerId, number> = new Map();
  private _deaths: Map<PlayerId, number> = new Map();
  private _teamScores: Map<TeamId, number> = new Map([
    ["udon", 0],
    ["soba", 0],
  ]);
  private _playerTeams: Map<PlayerId, TeamId> = new Map();
  private _teamNames: Map<TeamId, string> = new Map([
    ["udon", "Team Udon"],
    ["soba", "Team Soba"],
  ]);
  private config: MatchConfig;
  private gametypeName: string;
  /** Whether the owning gametype scores by team (drives tie/winner checks). */
  private teamBased: boolean;
  /** "single": per-match server — PostGame is terminal (no warmup restart);
   *  "continuous": classic warmup loop (default). */
  private _flow: "single" | "continuous" = "continuous";
  /** Match result, set on entering PostGame; cleared when warmup restarts. */
  private _winner: MatchWinner | null = null;
  /** Overtime extensions granted this match (0 = regulation). */
  private _overtimeCount = 0;

  constructor(gametypeName: string, config: Partial<MatchConfig> = {}, teamBased = false) {
    this.config = { ...DEFAULT_MATCH_CONFIG, ...config };
    this.gametypeName = gametypeName;
    this.teamBased = teamBased;
    this._timeRemaining = this.config.warmupTimeout;
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
    return this._readyPlayers.size;
  }
  get totalPlayers(): number {
    return this._totalPlayers;
  }
  get scores(): ReadonlyMap<PlayerId, number> {
    return this._scores;
  }
  get deaths(): ReadonlyMap<PlayerId, number> {
    return this._deaths;
  }
  get teamScores(): ReadonlyMap<TeamId, number> {
    return this._teamScores;
  }
  get playerTeams(): ReadonlyMap<PlayerId, TeamId> {
    return this._playerTeams;
  }
  get teamNames(): ReadonlyMap<TeamId, string> {
    return this._teamNames;
  }
  get winner(): MatchWinner | null {
    return this._winner;
  }
  get overtimeCount(): number {
    return this._overtimeCount;
  }
  get flow(): "single" | "continuous" {
    return this._flow;
  }

  /** Set the match flow mode (once, at server boot). */
  setFlow(flow: "single" | "continuous"): void {
    this._flow = flow;
    console.log(`[MatchState] Match flow: ${flow}`);
  }

  /** True when the current scores would end the match as a draw. */
  isTiedAtTop(): boolean {
    if (this.teamBased) {
      return (this._teamScores.get("udon") ?? 0) === (this._teamScores.get("soba") ?? 0);
    }
    let best = Number.NEGATIVE_INFINITY;
    let tied = false;
    for (const score of this._scores.values()) {
      if (score > best) {
        best = score;
        tied = false;
      } else if (score === best) {
        tied = true;
      }
    }
    return tied || this._scores.size === 0;
  }

  // ========================================================================
  // Winner
  // ========================================================================

  /**
   * Compute and store the match result from current scores. Called by the
   * controller when the match enters PostGame (both time-out and score-limit
   * paths). Team-based: highest team score wins; else highest player score.
   * Ties are a draw. `resolveName` maps a winning playerId to a display name.
   */
  computeWinner(teamBased: boolean, resolveName?: (playerId: PlayerId) => string): MatchWinner {
    if (teamBased) {
      const udon = this._teamScores.get("udon") ?? 0;
      const soba = this._teamScores.get("soba") ?? 0;
      if (udon === soba) {
        this._winner = { kind: "draw" };
      } else {
        const teamId: TeamId = udon > soba ? "udon" : "soba";
        this._winner = { kind: "team", id: teamId, name: this._teamNames.get(teamId) ?? teamId };
      }
      return this._winner;
    }

    // FFA/duel: top player score; only actual players (spectators hold no score entry).
    let best: PlayerId | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let tied = false;
    for (const [playerId, score] of this._scores) {
      if (score > bestScore) {
        best = playerId;
        bestScore = score;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }

    if (best === null || tied) {
      this._winner = { kind: "draw" };
    } else {
      this._winner = { kind: "player", id: best.toString(), name: resolveName?.(best) ?? `Player ${best}` };
    }
    return this._winner;
  }

  // ========================================================================
  // Match Configuration
  // ========================================================================

  getConfig(): Readonly<MatchConfig> {
    return this.config;
  }

  // ========================================================================
  // Player Management
  // ========================================================================

  addPlayer(playerId: PlayerId): void {
    this._totalPlayers++;
    this._scores.set(playerId, 0);
    this._deaths.set(playerId, 0);
    this._playerTeams.set(playerId, "spectator"); // default to spec
  }

  removePlayer(playerId: PlayerId): void {
    this._totalPlayers = Math.max(0, this._totalPlayers - 1);
    this._readyPlayers.delete(playerId);
    this._scores.delete(playerId);
    this._deaths.delete(playerId);
    this._playerTeams.delete(playerId);
  }

  playerReady(playerId: PlayerId): void {
    this._readyPlayers.add(playerId);
    console.log(`[MatchState] Player ${playerId} ready (${this._readyPlayers.size}/${this._totalPlayers})`);
  }

  playerUnready(playerId: PlayerId): void {
    this._readyPlayers.delete(playerId);
  }

  private allReady(): boolean {
    return this._totalPlayers >= 2 && this._readyPlayers.size >= this._totalPlayers;
  }

  // ========================================================================
  // Scoring
  // ========================================================================

  addScore(playerId: PlayerId, points: number = 1): void {
    if (this._phase !== MatchPhase.Active) return; // No scoring outside active phase
    const current = this._scores.get(playerId) || 0;
    this._scores.set(playerId, current + points);
  }

  getScore(playerId: PlayerId): number {
    return this._scores.get(playerId) || 0;
  }

  addDeath(playerId: PlayerId): void {
    const current = this._deaths.get(playerId) || 0;
    this._deaths.set(playerId, current + 1);
  }

  getDeaths(playerId: PlayerId): number {
    return this._deaths.get(playerId) || 0;
  }

  addTeamScore(teamId: TeamId, points: number = 1): void {
    if (this._phase !== MatchPhase.Active) return;
    const current = this._teamScores.get(teamId) || 0;
    this._teamScores.set(teamId, current + points);
  }

  getTeamScore(teamId: TeamId): number {
    return this._teamScores.get(teamId) || 0;
  }

  setPlayerTeam(playerId: PlayerId, teamId: TeamId): void {
    this._playerTeams.set(playerId, teamId);
  }

  getPlayerTeam(playerId: PlayerId): TeamId {
    return this._playerTeams.get(playerId) || "spectator";
  }

  setTeamName(teamId: TeamId, name: string): void {
    this._teamNames.set(teamId, name);
  }

  getTeamName(teamId: TeamId): string {
    return (
      this._teamNames.get(teamId) || (teamId === "udon" ? "Team Udon" : teamId === "soba" ? "Team Soba" : "Spectator")
    );
  }

  assignTeamBalance(playerId: PlayerId, gametypeName?: string): TeamId {
    let udonCount = 0;
    let sobaCount = 0;
    for (const team of this._playerTeams.values()) {
      if (team === "udon") udonCount++;
      if (team === "soba") sobaCount++;
    }

    let assignedTeam: TeamId;
    if (gametypeName === "Duel" && udonCount + sobaCount >= 2) {
      assignedTeam = "spectator";
    } else {
      assignedTeam = udonCount <= sobaCount ? "udon" : "soba";
    }

    this.setPlayerTeam(playerId, assignedTeam);
    return assignedTeam;
  }

  // ========================================================================
  // State Machine
  // ========================================================================

  /**
   * Update match state. Called once per server tick.
   * @param dt Delta time in seconds
   * @returns true if phase changed
   */
  update(dt: number): boolean {
    const prevPhase = this._phase;

    switch (this._phase) {
      case MatchPhase.Warmup:
        // Don't tick warmup timer when no players are connected
        if (this._totalPlayers === 0) {
          // Reset timer so warmup starts fresh when someone joins
          this._timeRemaining = this.config.warmupTimeout;
          break;
        }
        if (this.config.warmupTimeout > 0) {
          this._timeRemaining -= dt;
        }
        if (this.allReady() || (this.config.warmupTimeout > 0 && this._timeRemaining <= 0)) {
          this.transition(MatchPhase.Countdown);
        }
        break;

      case MatchPhase.Countdown:
        // If all players left during countdown, revert to warmup
        if (this._totalPlayers === 0) {
          this.transition(MatchPhase.Warmup);
          break;
        }
        this._timeRemaining -= dt;
        if (this._timeRemaining <= 0) {
          this.transition(MatchPhase.Active);
        }
        break;

      case MatchPhase.Active:
        // End match immediately if all players leave
        if (this._totalPlayers === 0) {
          this.transition(MatchPhase.PostGame);
          break;
        }
        if (this.config.timeLimit > 0) {
          this._timeRemaining -= dt;
          if (this._timeRemaining <= 0) {
            // Overtime (duel): a tie at the limit never ends the match — extend
            // it until someone takes the lead.
            if (this.config.overtimeOnDraw && this.isTiedAtTop()) {
              const extension = this.config.overtimeDuration ?? 60;
              this._timeRemaining += extension;
              this._overtimeCount++;
              console.log(`[MatchState] OVERTIME #${this._overtimeCount} — tied at the limit, +${extension}s`);
            } else {
              this.transition(MatchPhase.PostGame);
            }
          }
        }
        // Win condition checked externally by GametypeController
        break;

      case MatchPhase.PostGame:
        // Single-match server: PostGame is terminal. Players chat and return
        // to the lobby; the process exits when the last client leaves
        // (shutdownOnEmpty) or via the GameServer grace close. Never restart.
        if (this._flow === "single") {
          this._timeRemaining = Math.max(0, this._timeRemaining - dt);
          break;
        }
        // Continuous: classic loop — skip straight to warmup if no players
        if (this._totalPlayers === 0) {
          this.restart();
          break;
        }
        this._timeRemaining -= dt;
        if (this._timeRemaining <= 0) {
          this.restart();
        }
        break;
    }

    return this._phase !== prevPhase;
  }

  /**
   * Transition to a new match phase
   */
  transition(newPhase: MatchPhase): void {
    const oldPhase = this._phase;
    this._phase = newPhase;

    switch (newPhase) {
      case MatchPhase.Warmup:
        this._timeRemaining = this.config.warmupTimeout;
        this._readyPlayers.clear();
        this._winner = null; // previous match's result is over
        break;
      case MatchPhase.Countdown:
        this._timeRemaining = this.config.countdownDuration;
        break;
      case MatchPhase.Active:
        this._timeRemaining = this.config.timeLimit;
        this._overtimeCount = 0;
        // Reset scores and deaths on match start
        for (const [id] of this._scores) {
          this._scores.set(id, 0);
          this._deaths.set(id, 0);
        }
        this._teamScores.set("udon", 0);
        this._teamScores.set("soba", 0);
        break;
      case MatchPhase.PostGame:
        this._timeRemaining = this.config.postGameDuration;
        break;
    }

    const phaseNames = ["Warmup", "Countdown", "Active", "PostGame"];
    console.log(`[MatchState] ${phaseNames[oldPhase]} → ${phaseNames[newPhase]} (${this._timeRemaining.toFixed(1)}s)`);
  }

  /**
   * Restart match (PostGame → Warmup)
   */
  restart(): void {
    this.transition(MatchPhase.Warmup);
  }

  /**
   * Force transition to PostGame (when win condition met)
   */
  endMatch(): void {
    this.transition(MatchPhase.PostGame);
  }

  // ========================================================================
  // Snapshot for client
  // ========================================================================

  /**
   * Create a lightweight snapshot for sending to clients
   */
  toSnapshot(): MatchStateSnapshot {
    // Convert Maps to Records for simpler JSON serialization
    const teamScoresRec: Record<TeamId, number> = {
      udon: this._teamScores.get("udon") || 0,
      soba: this._teamScores.get("soba") || 0,
      spectator: 0,
    };
    const playerTeamsRec: Record<string, TeamId> = {};
    for (const [playerId, teamId] of this._playerTeams) {
      playerTeamsRec[playerId.toString()] = teamId;
    }
    const teamNamesRec: Record<TeamId, string> = {
      udon: this._teamNames.get("udon") || "Team Udon",
      soba: this._teamNames.get("soba") || "Team Soba",
      spectator: "Spectator",
    };

    return {
      phase: this._phase,
      timeRemaining: Math.max(0, this._timeRemaining),
      readyCount: this._readyPlayers.size,
      totalPlayers: this._totalPlayers,
      gametypeName: this.gametypeName,
      scoreLimit: this.config.scoreLimit,
      teamScores: teamScoresRec,
      playerTeams: playerTeamsRec,
      teamNames: teamNamesRec,
      winner: this._winner ?? undefined,
      overtime: this._overtimeCount > 0 ? this._overtimeCount : undefined,
      flow: this._flow,
    };
  }
}
