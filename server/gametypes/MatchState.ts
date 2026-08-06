/**
 * Match State Machine
 *
 * Manages match lifecycle: Warmup → Countdown → Active → PostGame
 * Follows Quake/Warsow convention for competitive FPS.
 */

import type { PlayerId } from "@engine/server/ecs/types";
import {
  emptyPlayerStats,
  type MatchConfig,
  MatchPhase,
  type MatchStateSnapshot,
  type MatchWinner,
  type PlayerStats,
  type RoundResult,
  type TeamId,
} from "@shared/server/gametype";

/**
 * How long a bots-only roster waits before it may start the match alone.
 *
 * Long enough for a browser to fetch and build a BSP and reach the server —
 * the window in which a lobby-spawned match has humans coming but none
 * connected yet. See `botsMayStartAlone`.
 */
const BOTS_ONLY_START_GRACE_SECONDS = 30;

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
  /** Players currently occupying an active match slot (spectators excluded). */
  private _activePlayers: Set<PlayerId> = new Set();
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

  // ── Round-based modes ──────────────────────────────────────────────────
  /** Current round, 1-based. 0 before the first round. Round modes only. */
  private _round = 0;
  /** Team attacking at the start of the match (round modes only). */
  private _startingAttacker: TeamId = "udon";
  /**
   * Set when the round timer runs out, cleared when the round ends.
   *
   * MatchState does NOT decide who wins a round on a timeout — "defenders win
   * if nothing was planted" is a gametype rule. The controller sees this flag,
   * asks the gametype, and calls `endRound()` with the answer.
   */
  private _roundTimeExpired = false;
  private _roundResult: RoundResult | null = null;
  private _botPlayers: ReadonlySet<PlayerId> = new Set();
  private _humanClients = 0;
  /** Lobby-spawned match: humans are coming, even if none have connected yet. */
  private _expectsHumans = false;
  private _stats: Map<PlayerId, PlayerStats> = new Map();
  /**
   * Derives score from stats, when the gametype wants that instead of frags.
   * Installed by the controller at boot; absent means "count frags".
   */
  private _scoreFromStats: ((stats: PlayerStats) => number) | null = null;

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

  /** Current round, 1-based; 0 before the first round. */
  get round(): number {
    return this._round;
  }

  /** True while this gametype plays in rounds. */
  get roundBased(): boolean {
    return this.config.roundBased === true;
  }

  /** True once the round timer has run out and the round has not yet ended. */
  get roundTimeExpired(): boolean {
    return this._roundTimeExpired;
  }

  /** Rounds each side attacks before the swap (round modes). */
  private get roundsPerHalf(): number {
    const value = this.config.roundsPerHalf ?? 0;
    return value > 0 ? value : Number.POSITIVE_INFINITY;
  }

  /**
   * Which team is attacking in the current round.
   *
   * Regulation splits the match into halves — one side attacks throughout the
   * first half, then they swap. Overtime alternates every round instead: by
   * then each team has had its full share of attacking rounds, and a win needs
   * a TWO-round lead, which spans one attack round for each side however they
   * fall. See Search_And_Destroy.md §4.3.
   */
  get attackingTeam(): TeamId {
    const other: TeamId = this._startingAttacker === "udon" ? "soba" : "udon";
    if (!this.roundBased || this._round <= 0) return this._startingAttacker;

    const regulationRounds = this.roundsPerHalf * 2;
    if (this._round > regulationRounds) {
      // Overtime: alternate, starting with the original attacker.
      const overtimeIndex = this._round - regulationRounds - 1;
      return overtimeIndex % 2 === 0 ? this._startingAttacker : other;
    }
    const half = Math.floor((this._round - 1) / this.roundsPerHalf);
    return half % 2 === 0 ? this._startingAttacker : other;
  }

  /** Team currently defending. */
  get defendingTeam(): TeamId {
    return this.attackingTeam === "udon" ? "soba" : "udon";
  }

  /** True once both halves have been played and the match is still undecided. */
  get inOvertime(): boolean {
    return this.roundBased && this._round > this.roundsPerHalf * 2;
  }

  /** Choose which side attacks first (round modes). */
  setStartingAttacker(team: TeamId): void {
    this._startingAttacker = team;
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

  /**
   * True when a team has both reached the score limit AND holds the required
   * lead (the "tennis rule").
   *
   * Warsow Bomb requires a two-round lead, so 10-9 is not a win and play
   * continues. That is also why overtime is entered at 9-9 rather than needing
   * a separate tie-break: after both halves, 9-9 is the only score that has not
   * already ended the match.
   */
  hasDecisiveLead(): boolean {
    const limit = this.config.scoreLimit;
    if (limit <= 0) return false;
    const lead = Math.max(1, this.config.leadRequired ?? 1);

    if (this.teamBased) {
      const udon = this._teamScores.get("udon") ?? 0;
      const soba = this._teamScores.get("soba") ?? 0;
      const top = Math.max(udon, soba);
      return top >= limit && Math.abs(udon - soba) >= lead;
    }

    let top = Number.NEGATIVE_INFINITY;
    let second = Number.NEGATIVE_INFINITY;
    for (const score of this._scores.values()) {
      if (score > top) {
        second = top;
        top = score;
      } else if (score > second) {
        second = score;
      }
    }
    if (top < limit) return false;
    return second === Number.NEGATIVE_INFINITY || top - second >= lead;
  }

  /**
   * End the current round, award it, and either start the next one or end the
   * match. Round modes only.
   *
   * `winner` is the gametype's decision — MatchState owns the round LOOP, not
   * the rules that decide a round.
   */
  endRound(winner: TeamId | null, result?: Omit<RoundResult, "round" | "winner" | "winnerName">): void {
    if (!this.roundBased || this._phase !== MatchPhase.Active) return;

    this._roundTimeExpired = false;
    if (winner && winner !== "spectator") {
      this.addTeamScore(winner, 1);
    }

    const udon = this._teamScores.get("udon") ?? 0;
    const soba = this._teamScores.get("soba") ?? 0;
    console.log(
      `[MatchState] Round ${this._round} → ${winner ?? "draw"} (udon ${udon} - ${soba} soba)` +
        `${this.inOvertime ? " [overtime]" : ""}`,
    );

    this._roundResult = {
      winner: winner ?? null,
      winnerName: winner ? (this._teamNames.get(winner) ?? winner) : "Nobody",
      reason: result?.reason ?? "eliminated",
      round: this._round,
      focus: result?.focus,
    };

    if (this.hasDecisiveLead()) {
      this.transition(MatchPhase.PostGame);
      return;
    }
    // The intermission: watch what happened, then the next freeze.
    this.transition(MatchPhase.RoundEnd);
  }

  /** How the last round ended. Cleared when the next one starts. */
  get roundResult(): RoundResult | null {
    return this._roundResult;
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
    if (this._activePlayers.has(playerId)) return;
    this._activePlayers.add(playerId);
    this._totalPlayers = this._activePlayers.size;
    if (!this._stats.has(playerId)) this._stats.set(playerId, emptyPlayerStats());
    if (!this._scores.has(playerId)) this._scores.set(playerId, 0);
    if (!this._deaths.has(playerId)) this._deaths.set(playerId, 0);
    this._playerTeams.set(playerId, "spectator"); // default to spec
  }

  removePlayer(playerId: PlayerId): void {
    this._activePlayers.delete(playerId);
    this._totalPlayers = this._activePlayers.size;
    this._stats.delete(playerId);
    this._readyPlayers.delete(playerId);
    this._scores.delete(playerId);
    this._deaths.delete(playerId);
    this._playerTeams.delete(playerId);
  }

  /** Leave the active roster without ending the connected player's session. */
  spectatePlayer(playerId: PlayerId): void {
    this._activePlayers.delete(playerId);
    this._totalPlayers = this._activePlayers.size;
    this._readyPlayers.delete(playerId);
    this._playerTeams.set(playerId, "spectator");
  }

  playerReady(playerId: PlayerId): void {
    if (!this._activePlayers.has(playerId)) return;
    this._readyPlayers.add(playerId);
    console.log(`[MatchState] Player ${playerId} ready (${this._readyPlayers.size}/${this._totalPlayers})`);
  }

  playerUnready(playerId: PlayerId): void {
    this._readyPlayers.delete(playerId);
  }

  /**
   * Everyone in, everyone ready — and not on bots alone.
   *
   * Bots ready the instant they join, so in a lobby match they reach the
   * threshold among themselves while the human is still loading the map. The
   * match then started without them: no warmup, and the player arrived partway
   * through a live round and spawned into it.
   *
   * A server with no humans connected still starts on bots (headless testing
   * depends on it). The rule is only that a human who IS connected gets to
   * ready before the match begins without them.
   */
  private allReady(): boolean {
    if (this._totalPlayers < 2 || this._readyPlayers.size < this._totalPlayers) return false;
    if (this._humanClients === 0) return this.botsMayStartAlone();
    for (const playerId of this._readyPlayers) {
      if (!this._botPlayers.has(playerId)) return true;
    }
    return false;
  }

  /**
   * Whether a roster of only bots is allowed to start the match yet.
   *
   * Bots ready the instant they join and a bot process connects in
   * milliseconds, while a human's browser has a BSP to download and build. So
   * "no humans are connected" is true for the first several seconds of every
   * lobby-spawned match — and taking it at face value started the match before
   * its players arrived. They then joined mid-round, which a round mode
   * correctly handles by spawning them dead: you loaded in already fragged,
   * having never seen a warmup.
   *
   * A genuinely bots-only server still starts on its own, just not instantly.
   * The wait costs headless runs a few seconds; getting it wrong costs a human
   * the entire first round.
   */
  private botsMayStartAlone(): boolean {
    // A standing dev or training server has nobody to wait for; making it sit
    // out the grace would tax every headless run for a problem it cannot have.
    if (!this._expectsHumans) return true;
    const elapsed = this.config.warmupTimeout - this._timeRemaining;
    return elapsed >= BOTS_ONLY_START_GRACE_SECONDS;
  }

  /**
   * Whether humans are expected to arrive, so bots must not start without them.
   *
   * True for a lobby-spawned match — the lobby launches one per queued group
   * and passes `--single-match`, which is the server's only advance notice that
   * anyone is on their way.
   */
  setExpectsHumans(expects: boolean): void {
    this._expectsHumans = expects;
  }

  /** Bots, so the ready gate can tell them from players. */
  setBotPlayers(bots: ReadonlySet<PlayerId>): void {
    this._botPlayers = bots;
  }

  /** Human clients connected, including those still spectating. */
  setHumanClients(count: number): void {
    this._humanClients = count;
  }

  // ========================================================================
  // Scoring
  // ========================================================================

  /** Install a gametype's score formula. Null restores plain frag counting. */
  setScoreFormula(formula: ((stats: PlayerStats) => number) | null): void {
    this._scoreFromStats = formula;
  }

  /** A player's accumulated stats. Always defined for a joined player. */
  getStats(playerId: PlayerId): PlayerStats {
    let stats = this._stats.get(playerId);
    if (!stats) {
      stats = emptyPlayerStats();
      this._stats.set(playerId, stats);
    }
    return stats;
  }

  /**
   * Record something a player did, and re-derive their score if the gametype
   * asked for that.
   *
   * Only counts while the match is live — warmup damage is practice, and a
   * scoreboard that remembers it is lying about the match.
   */
  recordStat(playerId: PlayerId, apply: (stats: PlayerStats) => void): void {
    if (this._phase !== MatchPhase.Active) return;
    const stats = this.getStats(playerId);
    apply(stats);
    if (this._scoreFromStats) {
      this._scores.set(playerId, Math.round(this._scoreFromStats(stats)));
    }
  }

  addScore(playerId: PlayerId, points: number = 1): void {
    // A derived score is a function of stats; adding to it directly would be
    // overwritten on the next stat and is a bug in the caller, not a no-op.
    if (this._scoreFromStats) return;
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
    const { udon: udonCount, soba: sobaCount } = this.teamSizes(playerId);

    let assignedTeam: TeamId;
    if (gametypeName === "Duel" && udonCount + sobaCount >= 2) {
      assignedTeam = "spectator";
    } else {
      assignedTeam = udonCount <= sobaCount ? "udon" : "soba";
    }

    this.setPlayerTeam(playerId, assignedTeam);
    return assignedTeam;
  }

  /**
   * Honour a requested side unless it is the bigger one.
   *
   * A join that names a team was taken at its word, so a player picking the
   * side that already had two bots turned a 2v2 into a 3v1 — and the mode has
   * no way back from that mid-match. Asking for the larger team now puts you on
   * the smaller one instead of being refused: the intent (get into the game) is
   * satisfiable, only the side is not.
   *
   * Excludes the joining player from the count, so re-joining the side you are
   * already on does not read as making it bigger.
   */
  assignTeamRespectingBalance(playerId: PlayerId, requested: TeamId, gametypeName?: string): TeamId {
    if (requested === "spectator") {
      this.setPlayerTeam(playerId, requested);
      return requested;
    }
    if (gametypeName === "Duel") return this.assignTeamBalance(playerId, gametypeName);

    const { udon, soba } = this.teamSizes(playerId);
    const requestedCount = requested === "udon" ? udon : soba;
    const otherCount = requested === "udon" ? soba : udon;

    const granted: TeamId = requestedCount > otherCount ? (requested === "udon" ? "soba" : "udon") : requested;
    if (granted !== requested) {
      console.log(
        `[MatchState] Player ${playerId} asked for ${requested} (${requestedCount}v${otherCount}) — placed on ${granted} to keep sides even`,
      );
    }
    this.setPlayerTeam(playerId, granted);
    return granted;
  }

  /** Players per side, not counting `excluding`. */
  private teamSizes(excluding?: PlayerId): { udon: number; soba: number } {
    let udon = 0;
    let soba = 0;
    for (const [id, team] of this._playerTeams) {
      if (excluding !== undefined && id === excluding) continue;
      if (team === "udon") udon++;
      if (team === "soba") soba++;
    }
    return { udon, soba };
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
            // Round modes: an expired timer ends the ROUND, not the match, and
            // who wins it is a gametype rule (for S&D, the defenders). Flag it
            // and let the controller ask; do not transition here.
            if (this.roundBased) {
              this._timeRemaining = 0;
              this._roundTimeExpired = true;
              break;
            }
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

      case MatchPhase.RoundEnd:
        // Fixed intermission. Nothing can shorten it — the beat exists so a
        // detonation is watched rather than cut away from.
        this._timeRemaining -= dt;
        if (this._timeRemaining <= 0) {
          this.transition(MatchPhase.Countdown);
        }
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
        this._round = 0;
        this._roundTimeExpired = false;
        break;
      case MatchPhase.RoundEnd:
        this._timeRemaining = this.config.roundEndDuration ?? 5;
        break;
      case MatchPhase.Countdown:
        this._timeRemaining = this.config.countdownDuration;
        // A new round is starting, so the last one's result is history.
        this._roundResult = null;
        // A round begins at its FREEZE, not when it goes live. Everything set
        // up during the freeze — where the bomb goes, which side attacks, who
        // spawns where — needs the round it is setting up for, not the one
        // that just ended. At the half boundary those are different teams.
        if (this.roundBased) this._round++;
        break;
      case MatchPhase.Active: {
        this._timeRemaining = this.config.timeLimit;
        this._overtimeCount = 0;
        this._roundTimeExpired = false;

        // In a round mode `Active` is entered once per ROUND, so scores must
        // survive it — only the first round starts a fresh match. The round
        // counter already advanced at the freeze.
        const startingMatch = !this.roundBased || this._round === 1;

        if (startingMatch) {
          for (const [id] of this._scores) {
            this._stats.set(id, emptyPlayerStats());
            this._scores.set(id, 0);
            this._deaths.set(id, 0);
          }
          this._teamScores.set("udon", 0);
          this._teamScores.set("soba", 0);
        }
        break;
      }
      case MatchPhase.PostGame:
        this._timeRemaining = this.config.postGameDuration;
        break;
    }

    const phaseNames = ["Warmup", "Countdown", "Active", "PostGame", "RoundEnd"];
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
      // Round context. Public by nature — everyone in a bomb round knows the
      // score and who is attacking — so it rides the broadcast snapshot rather
      // than per-client directives. Bots read `teamRoles` to pick a behavioural
      // weight profile (BOT_WEIGHTS_AND_GOALS.md §4.3).
      round: this.roundBased ? this._round : undefined,
      teamRoles: this.roundBased
        ? ({ [this.attackingTeam]: "attacker", [this.defendingTeam]: "defender" } as Record<string, string>)
        : undefined,
    };
  }
}
