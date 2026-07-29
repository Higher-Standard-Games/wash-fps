// Extracted from FPSHud.ts
import { HUDState } from "../../HUDState";
import { MatchStateManager } from "../../MatchStateManager";

// =============================================================================
// Phase 3: Scoreboard
// =============================================================================

/**
 * FPSScoreboard - Tab-toggle scoreboard overlay
 *
 * Not a regular HudWidget — it's a full-screen overlay managed by FPSHud.
 * Call toggle() or show/hide to control visibility.
 */
export class FPSScoreboard {
  private overlay: HTMLElement;
  private bodyEl: HTMLElement;
  private titleEl: HTMLElement;
  private visible: boolean = false;
  /** While true (post-game screen), hide() is ignored — board stays open. */
  private locked: boolean = false;
  /** Data signature of the last rebuild — refresh() skips when unchanged. */
  private lastSignature: string = "";
  /** Post-game roster memory: players seen on the board since the lock. When a
   *  client disconnects during the post-game (bots leave at +10s, ragequits),
   *  their row stays — dimmed — instead of vanishing from the final board. */
  // biome-ignore lint/suspicious/noExplicitAny: mirrors HUDState scoreboard entry shape
  private postGameRoster: Map<string, any> | null = null;
  private localPlayerId: string = "";
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

    // Header and layout generated dynamically in refresh()
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "fps-scoreboard-body";
    this.board.appendChild(this.bodyEl);

    // RETURN TO LOBBY — shown by the single-match post-game open-up beat.
    // Lives on the OVERLAY (refresh() wipes the board's innerHTML) and is the
    // only interactive element there (overlay itself is pointer-events: none).
    this.returnBtn = document.createElement("button");
    this.returnBtn.className = "fps-scoreboard-return";
    this.returnBtn.textContent = "RETURN TO LOBBY";
    this.returnBtn.style.display = "none";
    this.overlay.appendChild(this.returnBtn);

    // Winner stat panel — stands next to the 3D showcase model (left third)
    // during the post-game. Also overlay-mounted so refresh() can't wipe it.
    this.statsEl = document.createElement("div");
    this.statsEl.className = "fps-postgame-stats";
    this.statsEl.style.display = "none";
    this.overlay.appendChild(this.statsEl);

    // Giant winner nameplate rising behind the showcase model.
    this.nameEl = document.createElement("div");
    this.nameEl.className = "fps-postgame-name";
    this.nameEl.style.display = "none";
    this.overlay.appendChild(this.nameEl);

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

  public setLocalPlayerId(id: string): void {
    this.localPlayerId = id;
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
    if (winnerTitle !== null) {
      this.board.classList.add("fps-scoreboard--postgame");
      // Light, un-blurred veil + board shifted right so the 3D winner showcase
      // (left third of the view) stays readable.
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
   * Refresh the scoreboard rows from HUDState.
   *
   * Safe to call every HUD tick: the rebuild only runs when the underlying
   * data actually changed. Rebuilding unconditionally re-inserts elements,
   * which restarts their CSS entrance animations — a constant strobe on the
   * post-game board.
   */
  public refresh(): void {
    if (!this.visible) return;

    const state = HUDState.getInstance();

    // Post-game roster union: remember everyone seen since the lock, and keep
    // players who have since disconnected (bots leave at +10s, ragequits) as
    // dimmed rows with their final score instead of dropping them.
    // biome-ignore lint/suspicious/noExplicitAny: mirrors HUDState scoreboard entry shape
    const entries: any[] = [...state.scoreboard];
    if (this.postGameRoster) {
      for (const entry of entries) {
        this.postGameRoster.set(entry.playerId, { ...entry });
      }
      const liveIds = new Set(entries.map((e) => e.playerId));
      for (const [playerId, remembered] of this.postGameRoster) {
        if (!liveIds.has(playerId)) {
          entries.push({ ...remembered, departed: true });
        }
      }
    }

    const signature = JSON.stringify([
      state.teamNames,
      state.teamScores,
      entries,
      this.localPlayerId,
      MatchStateManager.getInstance().round,
    ]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    // Winner stat panel (post-game): frags / deaths / K-D next to the model.
    this.renderWinnerStats(entries);

    const hasTeams = Object.keys(state.teamScores).length > 0;

    // Clear existing layout
    this.board.innerHTML = "";

    // Add title
    this.board.appendChild(this.titleEl);

    // Round modes: which round this is, above the team columns. The SCORE is
    // already the team columns — this is the only number the scoreboard does
    // not otherwise carry, and without it a 4-3 match could be round 7 or
    // round 11 in overtime.
    const round = MatchStateManager.getInstance().round;
    if (round > 0) {
      const roundEl = document.createElement("div");
      roundEl.className = "fps-scoreboard-round";
      roundEl.textContent = `ROUND ${round}`;
      this.board.appendChild(roundEl);
    }

    if (hasTeams) {
      const teamsContainer = document.createElement("div");
      teamsContainer.className = "fps-scoreboard-teams";

      const createTeamScoreboard = (teamId: string, cssClass: string) => {
        const teamEl = document.createElement("div");
        teamEl.className = `fps-scoreboard-team ${cssClass}`;

        const teamName = state.teamNames[teamId] || `Team ${teamId}`;

        // Hide score from header since it's redundant with the columns below
        const title = document.createElement("div");
        title.className = "fps-scoreboard-team-title";
        title.textContent = teamName;
        teamEl.appendChild(title);

        const header = document.createElement("div");
        header.className = "fps-scoreboard-header";
        header.innerHTML = `
                    <span class="fps-scoreboard-col-name">Player</span>
                    <span class="fps-scoreboard-col-score">Score</span>
                    <span class="fps-scoreboard-col-ping">Ping</span>
                `;
        teamEl.appendChild(header);

        const body = document.createElement("div");
        body.className = "fps-scoreboard-body";
        teamEl.appendChild(body);

        return { container: teamEl, body };
      };

      const udon = createTeamScoreboard("udon", "fps-scoreboard-team--udon");
      const soba = createTeamScoreboard("soba", "fps-scoreboard-team--soba");
      const specs: any[] = []; // Collect spectators to show later if needed

      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "fps-scoreboard-row";
        if (entry.playerId === this.localPlayerId) {
          row.classList.add("fps-scoreboard-row--self");
        }
        if (entry.departed) {
          row.classList.add("fps-scoreboard-row--departed");
        }
        row.innerHTML = `
                    <span class="fps-scoreboard-col-name">${this.escapeHtml(entry.name)}</span>
                    <span class="fps-scoreboard-col-score">${entry.score}</span>
                    <span class="fps-scoreboard-col-ping">${entry.departed ? "LEFT" : `${entry.ping}ms`}</span>
                `;

        if (entry.teamId === "udon") udon.body.appendChild(row);
        else if (entry.teamId === "soba") soba.body.appendChild(row);
        else specs.push(entry);
      }

      teamsContainer.appendChild(udon.container);
      teamsContainer.appendChild(soba.container);
      this.board.appendChild(teamsContainer);

      // Add spectators row if any
      if (specs.length > 0) {
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
          if (entry.playerId === this.localPlayerId) {
            row.classList.add("fps-scoreboard-row--self");
          }
          row.innerHTML = `<span class="fps-scoreboard-col-name">${this.escapeHtml(entry.name)}</span>`;
          body.appendChild(row);
        }

        specsContainer.appendChild(body);
        this.board.appendChild(specsContainer);
      }

      // Keep reference for standard destroy/updates
      this.bodyEl = udon.body; // Just as a fallback for the instance property
    } else {
      // Standard FFA
      const header = document.createElement("div");
      header.className = "fps-scoreboard-header";
      header.innerHTML = `
                <span class="fps-scoreboard-col-name">Player</span>
                <span class="fps-scoreboard-col-score">Score</span>
                <span class="fps-scoreboard-col-deaths">Deaths</span>
                <span class="fps-scoreboard-col-ping">Ping</span>
            `;
      this.board.appendChild(header);

      this.bodyEl = document.createElement("div");
      this.bodyEl.className = "fps-scoreboard-body";
      this.board.appendChild(this.bodyEl);

      const ffaSpecs: typeof state.scoreboard = [];
      for (const entry of entries) {
        if (entry.teamId === "spectator") {
          ffaSpecs.push(entry);
          continue;
        }
        const row = document.createElement("div");
        row.className = "fps-scoreboard-row";
        if (entry.playerId === this.localPlayerId) {
          row.classList.add("fps-scoreboard-row--self");
        }
        if (entry.departed) {
          row.classList.add("fps-scoreboard-row--departed");
        }

        row.innerHTML = `
                    <span class="fps-scoreboard-col-name">${this.escapeHtml(entry.name)}</span>
                    <span class="fps-scoreboard-col-score">${entry.score}</span>
                    <span class="fps-scoreboard-col-deaths">${entry.deaths}</span>
                    <span class="fps-scoreboard-col-ping">${entry.departed ? "LEFT" : `${entry.ping}ms`}</span>
                `;
        this.bodyEl.appendChild(row);
      }

      this.appendSpectators(ffaSpecs);
    }
  }

  /**
   * Winner stat panel next to the showcase model (post-game only). Values come
   * from the same entry union as the board, so they show the final score even
   * mid-refresh and survive the winner disconnecting.
   */
  // biome-ignore lint/suspicious/noExplicitAny: mirrors HUDState scoreboard entry shape
  private renderWinnerStats(entries: any[]): void {
    if (!this.winnerPlayerId) return;
    const entry = entries.find((e) => e.playerId === this.winnerPlayerId);
    if (!entry) {
      this.statsEl.style.display = "none";
      return;
    }

    const frags = Number(entry.score ?? 0);
    const deaths = Number(entry.deaths ?? 0);
    const kd = deaths > 0 ? (frags / deaths).toFixed(2) : frags.toFixed(2);

    this.statsEl.innerHTML = `
      <div class="fps-postgame-stats-row"><span class="fps-postgame-stats-label">Frags</span><span class="fps-postgame-stats-value">${frags}</span></div>
      <div class="fps-postgame-stats-row"><span class="fps-postgame-stats-label">Deaths</span><span class="fps-postgame-stats-value">${deaths}</span></div>
      <div class="fps-postgame-stats-row"><span class="fps-postgame-stats-label">K/D</span><span class="fps-postgame-stats-value">${kd}</span></div>
    `;
    this.statsEl.style.display = "";
  }

  /** Render a "SPECTATORS (n)" block at the bottom of the board. */
  private appendSpectators(specs: Array<{ playerId: string; name: string }>): void {
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
      if (entry.playerId === this.localPlayerId) {
        row.classList.add("fps-scoreboard-row--self");
      }
      row.innerHTML = `<span class="fps-scoreboard-col-name">${this.escapeHtml(entry.name)}</span>`;
      body.appendChild(row);
    }
    specsContainer.appendChild(body);
    this.board.appendChild(specsContainer);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  public destroy(): void {
    this.overlay.remove();
  }
}
