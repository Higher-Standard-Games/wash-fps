/**
 * MatchInputBindings — the document-level keys and clicks a connected match
 * listens for: spectator target cycling, chase-cam on Mouse1, J to join, and
 * hold-Tab for the scoreboard.
 *
 * Game decides what each one does through {@link MatchInputActions}; this class
 * owns when they fire and their lifetime. Every listener shares one
 * AbortController, so unbind() removes all of them and a listener cannot be
 * added without a way out.
 */

export interface MatchInputActions {
  /** The local player's state; "spectator" means free spectating. */
  playerState(): string;
  /** Dead in a round mode and watching a teammate. */
  isSpectatingTeammate(): boolean;
  cycleTeammate(direction: 1 | -1): void;
  nextSpectateTarget(): void;
  prevSpectateTarget(): void;
  /** Following a player in chase-cam (as opposed to freefly). */
  isChasing(): boolean;
  exitChaseCam(): void;
  /** Raw key state from the input system. */
  isKeyDown(code: string): boolean;
  joinGame(): void;
  /** A pause or settings menu is open, which Tab then belongs to. */
  menuOpen(): boolean;
  /** The spectator's join overlay is showing. */
  joinOverlayOpen(): boolean;
  showScoreboard(): void;
  hideScoreboard(): void;
}

export class MatchInputBindings {
  private abort: AbortController | null = null;

  /** Start listening on `target` (the document). Rebinding first unbinds. */
  bind(target: Pick<Document, "addEventListener" | "pointerLockElement">, actions: MatchInputActions): void {
    this.unbind();
    const abort = new AbortController();
    this.abort = abort;
    const options = { signal: abort.signal };

    // ── Spectator cycling (arrows + Space) ──
    target.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Dead in a round mode is spectating too, even though the player state
        // still says "playing" — they have an entity, it is just a corpse.
        // Without this the arrows did nothing for the one case that lasts a
        // whole minute, and you watched whoever the auto-pick happened to land
        // on until they died.
        if (actions.playerState() !== "spectator") {
          if (!actions.isSpectatingTeammate()) return;
          if (e.code === "ArrowRight") {
            e.preventDefault();
            actions.cycleTeammate(1);
          } else if (e.code === "ArrowLeft") {
            e.preventDefault();
            actions.cycleTeammate(-1);
          }
          return;
        }
        if (e.code === "ArrowRight") {
          e.preventDefault();
          actions.nextSpectateTarget();
        } else if (e.code === "ArrowLeft") {
          e.preventDefault();
          actions.prevSpectateTarget();
        } else if (e.code === "Space" || e.code === "Backspace") {
          // Return to freefly from chase-cam
          if (actions.isChasing()) {
            e.preventDefault();
            actions.exitChaseCam();
          }
        }
      },
      options,
    );

    // ── Mouse1 (left click): chase-cam ──
    // Matches the freefly cue label ("MOUSE1 Chase Player"). Enter chase from
    // freefly, or advance to the next player while already chasing; ←/→ cycle
    // and Space/Backspace returns to freefly. Ignored until the pointer is
    // locked so the click that engages mouselook doesn't jump straight into a
    // chase. Middle-click is reserved for "fly down" (crouch), so it is NOT a
    // chase alias here.
    target.addEventListener(
      "mousedown",
      (e: MouseEvent) => {
        if (actions.playerState() !== "spectator") return;
        if (e.button !== 0) return;
        if (!target.pointerLockElement) return;
        e.preventDefault();
        actions.nextSpectateTarget();
      },
      options,
    );

    // ── J: join the game from spectator mode ──
    // Reads the input system's raw key state (this runs in an event handler, not per frame).
    target.addEventListener(
      "keydown",
      () => {
        if (actions.isKeyDown("KeyJ") && actions.playerState() === "spectator") actions.joinGame();
      },
      options,
    );

    // ── Tab: hold to show the scoreboard (Quake style) ──
    // With a menu up, Tab is the keyboard's way through its keys instead.
    target.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.code !== "Tab") return;
        if (actions.menuOpen()) return;
        if (actions.joinOverlayOpen()) return;
        e.preventDefault();
        actions.showScoreboard();
      },
      options,
    );
    target.addEventListener(
      "keyup",
      (e: KeyboardEvent) => {
        if (e.code !== "Tab") return;
        e.preventDefault();
        actions.hideScoreboard();
      },
      options,
    );
  }

  /** Remove every listener bind() added. Safe to call when not bound. */
  unbind(): void {
    this.abort?.abort();
    this.abort = null;
  }

  isBound(): boolean {
    return this.abort !== null;
  }
}
