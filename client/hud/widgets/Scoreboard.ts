// Extracted from FPSHud.ts
import { createRaisedKey } from "../../../../../engine/ui/components/RaisedKey";
import { HUDState, type ScoreboardEntry } from "../../HUDState";
import { MatchStateManager } from "../../MatchStateManager";

// =============================================================================
// Phase 3: Scoreboard
// =============================================================================

/** A board row: a scoreboard entry, or a post-game row kept for a player who left. */
type BoardEntry = ScoreboardEntry & { departed?: boolean };

/** The two sides of a team mode, in the order the lobby lists them. */
const SIDES = ["soba", "udon"] as const;

/**
 * FPSScoreboard - Tab-toggle scoreboard overlay, and the post-game result screen
 *
 * Not a regular HudWidget — it's a full-screen overlay managed by FPSHud.
 * Call toggle() or show/hide to control visibility.
 *
 * Post-game composition: the winner's 3D model stands in the left third (framed
 * by PostGameShowcase), with the stage caption (giant name, stat chips) above
 * it; the board is the right column, titled by a static winner plate; the way
 * home sits under the board's right edge. A 1v1 gets a head-to-head instead of
 * two team columns of one row each.
 */
export class FPSScoreboard {
  private overlay: HTMLElement;
  /** Everything below the title plate. Rebuilt; the plate is not, so its stamp plays once. */
  private contentEl: HTMLElement;
  private titleEl: HTMLElement;
  private visible: boolean = false;
  /** While true (post-game screen), hide() is ignored — board stays open. */
  private locked: boolean = false;
  /** Structure signature of the last rebuild (everything but ping) — refresh() skips when unchanged. */
  private lastSignature: string = "";
  /** What the last refresh() was computed from, compared by identity. */
  private readonly lastInputs: {
    scoreboard: unknown;
    localPlayerId: string;
    round: number;
    carrier: unknown;
    winner: string | null;
  } = { scoreboard: null, localPlayerId: "", round: -1, carrier: null, winner: null };
  /** Post-game roster memory: players seen on the board since the lock. When a
   *  client disconnects during the post-game (bots leave at +10s, ragequits),
   *  their row stays — dimmed — instead of vanishing from the final board. */
  private postGameRoster: Map<string, BoardEntry> | null = null;
  private board: HTMLElement;
  private returnBtn: HTMLButtonElement;
  private statsEl: HTMLElement;
  private nameEl: HTMLElement;
  /** Winner's playerId ("player_<id>") while the post-game board is up. */
  private winnerPlayerId: string | null = null;

  constructor() {
    this.overlay = document.createElement("div");
    this.overlay.className = "fps-scoreboard-overlay";
    this.overlay.style.display = "none";

    this.board = document.createElement("div");
    this.board.className = "fps-scoreboard";

    this.titleEl = document.createElement("div");
    this.titleEl.className = "fps-scoreboard-title";
    this.titleEl.textContent = "SCOREBOARD";
    this.board.appendChild(this.titleEl);

    this.contentEl = document.createElement("div");
    this.contentEl.className = "fps-scoreboard-content";
    this.board.appendChild(this.contentEl);

    // Back to the lobby — shown by the single-match post-game open-up beat. The
    // only interactive element (the overlay itself is pointer-events: none).
    this.returnBtn = createRaisedKey({ label: "Back to the lobby", variants: ["cta"] });
    this.returnBtn.classList.add("fps-scoreboard-return");
    this.returnBtn.style.display = "none";
    this.overlay.appendChild(this.returnBtn);

    // Stage caption over the 3D showcase model: the winner's giant nameplate
    // and their stat chips, stacked so a long name pushes the chips down
    // instead of running into them.
    const stage = document.createElement("div");
    stage.className = "fps-postgame-stage";

    this.nameEl = document.createElement("div");
    this.nameEl.className = "fps-postgame-name";
    this.nameEl.style.display = "none";
    stage.appendChild(this.nameEl);

    this.statsEl = document.createElement("div");
    this.statsEl.className = "fps-postgame-stats";
    this.statsEl.style.display = "none";
    stage.appendChild(this.statsEl);

    this.overlay.appendChild(stage);
    this.overlay.appendChild(this.board);
    document.body.appendChild(this.overlay);
  }

  /**
   * Show the RETURN TO LOBBY button with the given action, or hide it (null).
   * Single-match flow only — the post-game is terminal and this is the exit.
   */
  public setReturnAction(onReturn: (() => void) | null): void {
    this.returnBtn.onclick = onReturn;
    this.returnBtn.style.display = onReturn ? "" : "none";
  }

  public setTitle(title: string): void {
    this.titleEl.textContent = title;
  }

  public toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  public show(): void {
    this.visible = true;
    this.overlay.style.display = "";
    this.refresh();
  }

  public hide(): void {
    if (this.locked) return; // post-game screen holds the board open
    this.visible = false;
    this.overlay.style.display = "none";
  }

  /**
   * Lock the scoreboard open (post-game screen). While locked, hide() —
   * including the Tab-release handler — is ignored. Unlocking does not hide;
   * the caller decides (so warmup can close it explicitly).
   */
  public setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) this.show();
  }

  /**
   * Enter/exit post-game presentation: locked open, enlarged (--postgame
   * variant), and titled with the match result ("WRAITH WINS!").
   * Pass null to return to the plain Tab scoreboard.
   */
  public setPostGame(
    winnerTitle: string | null,
    winnerPlayerId: string | null = null,
    winnerName: string | null = null,
  ): void {
    this.lastSignature = ""; // the layout changes either way
    if (winnerTitle !== null) {
      this.board.classList.add("fps-scoreboard--postgame");
      this.overlay.classList.add("fps-scoreboard-overlay--postgame");
      this.postGameRoster = new Map(); // remember departing players' final rows
      this.winnerPlayerId = winnerPlayerId;
      this.setTitle(winnerTitle);
      if (winnerName) {
        this.nameEl.textContent = winnerName;
        this.nameEl.style.display = "";
      }
      this.setLocked(true);
    } else {
      this.board.classList.remove("fps-scoreboard--postgame");
      this.overlay.classList.remove("fps-scoreboard-overlay--postgame");
      this.postGameRoster = null;
      this.winnerPlayerId = null;
      this.statsEl.style.display = "none";
      this.nameEl.style.display = "none";
      this.setTitle("SCOREBOARD");
      this.setLocked(false);
      this.setReturnAction(null);
      this.hide();
    }
  }

  public isVisible(): boolean {
    return this.visible;
  }

  /**
   * Refresh the scoreboard from HUDState.
   *
   * Safe to call every HUD tick. The layout is rebuilt only when something
   * other than ping changed; pings are written into their cells in place, as
   * they change several times a second. The title plate is never rebuilt, so
   * its entrance stamp plays once per opening rather than on every rebuild.
   */
  public refresh(): void {
    if (!this.visible) return;

    const state = HUDState.getInstance();
    const localPlayerId = state.localPlayerId;
    const match = MatchStateManager.getInstance();
    const round = match.round;
    const carrier = match.bomb?.carrier ?? null;

    // The board's inputs only change when a snapshot replaces the scoreboard
    // array (pings included), so between snapshots, which is most HUD ticks,
    // there is nothing to compare or write.
    const inputs = this.lastInputs;
    if (
      this.lastSignature !== "" &&
      inputs.scoreboard === state.scoreboard &&
      inputs.localPlayerId === localPlayerId &&
      inputs.round === round &&
      inputs.carrier === carrier &&
      inputs.winner === this.winnerPlayerId
    ) {
      return;
    }
    inputs.scoreboard = state.scoreboard;
    inputs.localPlayerId = localPlayerId;
    inputs.round = round;
    inputs.carrier = carrier;
    inputs.winner = this.winnerPlayerId;

    const entries = this.collectEntries(state);

    const signature = JSON.stringify([
      state.teamBased,
      state.teamNames,
      state.teamScores,
      entries.map((e) => [e.playerId, e.name, e.score, e.frags, e.deaths, e.teamId, e.departed === true]),
      localPlayerId,
      round,
      carrier,
      this.winnerPlayerId,
    ]);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.renderWinnerStats(entries);
      this.rebuild(state, entries, localPlayerId, round);
    }
    this.writePings(entries);
  }

  /**
   * The rows to show. On the post-game board, everyone seen since the lock: a
   * player who has since disconnected (bots leave at +10s, ragequits) keeps a
   * dimmed row with their final score instead of dropping off.
   */
  private collectEntries(state: HUDState): BoardEntry[] {
    const entries: BoardEntry[] = [...state.scoreboard];
    if (!this.postGameRoster) return entries;
    for (const entry of entries) this.postGameRoster.set(entry.playerId, { ...entry });
    const liveIds = new Set(entries.map((e) => e.playerId));
    for (const [playerId, remembered] of this.postGameRoster) {
      if (!liveIds.has(playerId)) entries.push({ ...remembered, departed: true });
    }
    return entries;
  }

  private rebuild(state: HUDState, entries: BoardEntry[], localPlayerId: string, round: number): void {
    this.contentEl.innerHTML = "";
    const postGame = this.postGameRoster !== null;

    // Team-ness comes from the gametype, not from the presence of team scores:
    // those ship with both sides populated in every gametype, so a free-for-all
    // read as a team game and every player landed in the spectator list.
    if (!state.teamBased) {
      this.renderFreeForAll(entries, localPlayerId);
      return;
    }

    const players = entries.filter((e) => e.teamId === "soba" || e.teamId === "udon");
    const spectators = entries.filter((e) => e.teamId !== "soba" && e.teamId !== "udon");
    const sideOf = (side: string) => players.filter((e) => e.teamId === side);

    // Round modes: which round this is. On the post-game board the match is
    // over and the score below says how it went, so the counter is left off.
    if (round > 0 && !postGame) {
      const roundEl = document.createElement("div");
      roundEl.className = "fps-scoreboard-round";
      roundEl.textContent = `ROUND ${round}`;
      this.contentEl.appendChild(roundEl);
    }

    // Coloured by allegiance, not by name: your side is the ally colour and
    // theirs is the enemy colour, so the board matches the models in the map.
    const localTeam = entries.find((e) => e.playerId === localPlayerId)?.teamId;
    const allegiance = (side: string) => (localTeam && side === localTeam ? "ally" : "enemy");

    if (SIDES.every((side) => sideOf(side).length <= 1) && players.length > 0) {
      this.renderHeadToHead(state, sideOf, allegiance, localPlayerId, round > 0);
    } else {
      this.renderTeams(state, sideOf, allegiance, localPlayerId);
    }
    this.appendSpectators(spectators, localPlayerId);
  }

  /**
   * A 1v1: one versus line instead of two team columns of one row each, where
   * the player's name showed twice and the plate's number and the row's
   * number sat side by side unlabelled. The big figure is rounds won in a
   * round mode and frags otherwise, and says which. The winner stands on the
   * left of the post-game board; otherwise the sides keep the lobby's order.
   */
  private renderHeadToHead(
    state: HUDState,
    sideOf: (side: string) => BoardEntry[],
    allegiance: (side: string) => string,
    localPlayerId: string,
    roundMode: boolean,
  ): void {
    let order: string[] = [...SIDES];
    const winnerSide = this.winnerPlayerId
      ? sideOf("udon").some((e) => e.playerId === this.winnerPlayerId)
        ? "udon"
        : "soba"
      : null;
    if (winnerSide === "udon") order = ["udon", "soba"];

    const versus = document.createElement("div");
    versus.className = "fps-scoreboard-versus";

    const figure = (side: string): number => {
      if (roundMode) return state.teamScores[side] ?? 0;
      return sideOf(side)[0]?.score ?? 0;
    };

    const sideEl = (side: string, position: "left" | "right") => {
      const player = sideOf(side)[0];
      const el = document.createElement("div");
      el.className = `fps-versus-side fps-versus-side--${position} fps-versus-side--${allegiance(side)}`;
      if (player?.playerId === localPlayerId) el.classList.add("fps-versus-side--self");
      if (player?.departed) el.classList.add("fps-versus-side--departed");

      const name = document.createElement("div");
      name.className = "fps-versus-name";
      name.textContent = player?.name ?? "Waiting…";
      el.appendChild(name);

      if (player) {
        const line = document.createElement("div");
        line.className = "fps-versus-line";
        line.textContent = roundMode ? `${player.score} frags · ${player.deaths} deaths` : `${player.deaths} deaths`;
        el.appendChild(line);

        const ping = document.createElement("div");
        ping.className = "fps-versus-ping";
        ping.dataset.pingFor = player.playerId;
        el.appendChild(ping);
      }
      return el;
    };

    const score = document.createElement("div");
    score.className = "fps-versus-score";
    const figureEl = document.createElement("div");
    figureEl.className = "fps-versus-figure";
    figureEl.textContent = `${figure(order[0])} — ${figure(order[1])}`;
    score.appendChild(figureEl);
    const label = document.createElement("div");
    label.className = "fps-versus-label";
    label.textContent = roundMode ? "Rounds" : "Frags";
    score.appendChild(label);

    versus.appendChild(sideEl(order[0], "left"));
    versus.appendChild(score);
    versus.appendChild(sideEl(order[1], "right"));
    this.contentEl.appendChild(versus);
  }

  /** Two team columns: Soba left, Udon right — the order the lobby lists them in. */
  private renderTeams(
    state: HUDState,
    sideOf: (side: string) => BoardEntry[],
    allegiance: (side: string) => string,
    localPlayerId: string,
  ): void {
    const teamsContainer = document.createElement("div");
    teamsContainer.className = "fps-scoreboard-teams";

    // Who is holding the bomb, so the board answers "who has it" — the one
    // question a Search & Destroy scoreboard is opened to settle.
    const carrier = MatchStateManager.getInstance().bomb?.carrier ?? null;

    for (const side of SIDES) {
      const teamEl = document.createElement("div");
      teamEl.className = `fps-scoreboard-team fps-scoreboard-team--${allegiance(side)}`;

      // The team score, in the header: in a round mode it is ROUNDS WON and
      // appears nowhere else on the board.
      const title = document.createElement("div");
      title.className = "fps-scoreboard-team-title";
      const nameEl = document.createElement("span");
      nameEl.className = "fps-scoreboard-team-name";
      nameEl.textContent = state.teamNames[side] || `Team ${side}`;
      title.appendChild(nameEl);
      const scoreEl = document.createElement("span");
      scoreEl.className = "fps-scoreboard-team-score";
      scoreEl.textContent = String(state.teamScores[side] ?? 0);
      title.appendChild(scoreEl);
      teamEl.appendChild(title);

      teamEl.appendChild(this.header(["name", "score", "ping"]));

      const body = document.createElement("div");
      body.className = "fps-scoreboard-body";
      for (const entry of sideOf(side)) {
        const row = this.row(entry, localPlayerId, ["name", "score", "ping"]);
        if (carrier !== null && entry.playerId === carrier) {
          row.classList.add("fps-scoreboard-row--carrier");
          const mark = document.createElement("span");
          mark.className = "fps-scoreboard-carrier";
          mark.title = "Carrying the bomb";
          row.firstElementChild?.prepend(mark);
        }
        body.appendChild(row);
      }
      teamEl.appendChild(body);
      teamsContainer.appendChild(teamEl);
    }

    this.contentEl.appendChild(teamsContainer);
  }

  private renderFreeForAll(entries: BoardEntry[], localPlayerId: string): void {
    this.contentEl.appendChild(this.header(["name", "score", "deaths", "ping"]));
    const body = document.createElement("div");
    body.className = "fps-scoreboard-body";
    const spectators: BoardEntry[] = [];
    for (const entry of entries) {
      if (entry.teamId === "spectator") {
        spectators.push(entry);
        continue;
      }
      body.appendChild(this.row(entry, localPlayerId, ["name", "score", "deaths", "ping"]));
    }
    this.contentEl.appendChild(body);
    this.appendSpectators(spectators, localPlayerId);
  }

  private header(columns: readonly Column[]): HTMLElement {
    const header = document.createElement("div");
    header.className = "fps-scoreboard-header";
    for (const column of columns) {
      const cell = document.createElement("span");
      cell.className = `fps-scoreboard-col-${column}`;
      cell.textContent = COLUMN_TITLES[column];
      header.appendChild(cell);
    }
    return header;
  }

  private row(entry: BoardEntry, localPlayerId: string, columns: readonly Column[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "fps-scoreboard-row";
    if (entry.playerId === localPlayerId) row.classList.add("fps-scoreboard-row--self");
    if (entry.departed) row.classList.add("fps-scoreboard-row--departed");
    for (const column of columns) {
      const cell = document.createElement("span");
      cell.className = `fps-scoreboard-col-${column}`;
      if (column === "name") cell.textContent = entry.name;
      else if (column === "score") cell.textContent = String(entry.score);
      else if (column === "deaths") cell.textContent = String(entry.deaths);
      else cell.dataset.pingFor = entry.playerId;
      row.appendChild(cell);
    }
    return row;
  }

  /** Write each ping cell's value in place; a departed player's reads LEFT. */
  private writePings(entries: BoardEntry[]): void {
    const byId = new Map(entries.map((e) => [e.playerId, e]));
    for (const cell of this.contentEl.querySelectorAll<HTMLElement>("[data-ping-for]")) {
      const entry = byId.get(cell.dataset.pingFor ?? "");
      const text = !entry ? "" : entry.departed ? "LEFT" : `${entry.ping}ms`;
      if (cell.textContent !== text) cell.textContent = text;
    }
  }

  /**
   * Winner stat chips under the stage caption (post-game only). Values come
   * from the same entry union as the board, so they show the final score even
   * mid-refresh and survive the winner disconnecting.
   */
  private renderWinnerStats(entries: BoardEntry[]): void {
    if (!this.winnerPlayerId) return;
    const entry = entries.find((e) => e.playerId === this.winnerPlayerId);
    if (!entry) {
      this.statsEl.style.display = "none";
      return;
    }

    const frags = entry.frags;
    const deaths = Number(entry.deaths ?? 0);
    const kd = frags === undefined ? null : deaths > 0 ? (frags / deaths).toFixed(2) : frags.toFixed(2);

    this.statsEl.innerHTML = "";
    for (const [label, value] of [
      ["Score", String(entry.score ?? 0)],
      ...(frags === undefined ? [] : [["Frags", String(frags)]]),
      ["Deaths", String(deaths)],
      ...(kd === null ? [] : [["K/D", kd]]),
    ]) {
      const chip = document.createElement("div");
      chip.className = "fps-postgame-stats-row";
      const labelEl = document.createElement("span");
      labelEl.className = "fps-postgame-stats-label";
      labelEl.textContent = label;
      const valueEl = document.createElement("span");
      valueEl.className = "fps-postgame-stats-value";
      valueEl.textContent = value;
      chip.append(labelEl, valueEl);
      this.statsEl.appendChild(chip);
    }
    this.statsEl.style.display = "";
  }

  /** Render a "SPECTATORS (n)" block at the bottom of the board. */
  private appendSpectators(specs: BoardEntry[], localPlayerId: string): void {
    if (specs.length === 0) return;
    const specsContainer = document.createElement("div");
    specsContainer.className = "fps-scoreboard-spectators";

    const title = document.createElement("div");
    title.className = "fps-scoreboard-spectators-title";
    title.textContent = `SPECTATORS (${specs.length})`;
    specsContainer.appendChild(title);

    const body = document.createElement("div");
    body.className = "fps-scoreboard-spectators-body";
    for (const entry of specs) {
      const row = document.createElement("div");
      row.className = "fps-scoreboard-spectator-row";
      if (entry.playerId === localPlayerId) row.classList.add("fps-scoreboard-row--self");
      const name = document.createElement("span");
      name.className = "fps-scoreboard-col-name";
      name.textContent = entry.name;
      row.appendChild(name);
      body.appendChild(row);
    }
    specsContainer.appendChild(body);
    this.contentEl.appendChild(specsContainer);
  }

  public destroy(): void {
    this.overlay.remove();
  }
}

type Column = "name" | "score" | "deaths" | "ping";

const COLUMN_TITLES: Record<Column, string> = {
  name: "Player",
  score: "Score",
  deaths: "Deaths",
  ping: "Ping",
};
