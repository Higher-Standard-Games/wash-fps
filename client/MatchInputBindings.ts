/**
 * MatchInputBindings — the document-level keys and clicks a connected match
 * listens for: spectator target cycling, chase-cam on Mouse1, J to join,
 * hold-Tab for the scoreboard, and Escape for the match menu while spectating.
 *
 * Game decides what each one does through {@link MatchInputActions}; this class
 * owns when they fire and their lifetime. Every listener shares one
 * AbortController, so unbind() removes all of them and a listener cannot be
 * added without a way out.
 */

import { EventBus } from "../../../engine/core/EventBus";
import { CONTROLLER_MATCH_INPUT, type ControllerMatchInput } from "./ControllerEvents";
import { FPS } from "./FPSActions";

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
  /** Open the match menu. */
  openMatchMenu(): void;
  /** The spectator's join overlay is showing. */
  joinOverlayOpen(): boolean;
  showScoreboard(): void;
  hideScoreboard(): void;
}

export class MatchInputBindings {
  private abort: AbortController | null = null;
  private offController: (() => void) | null = null;

  /** Start listening on `target` (the document). Rebinding first unbinds. */
  bind(target: Pick<Document, "addEventListener" | "pointerLockElement">, actions: MatchInputActions): void {
    this.unbind();
    const abort = new AbortController();
    this.abort = abort;
    const options = { signal: abort.signal };
    const scoreboard = { keyboard: false, gamepad: false };
    const refreshScoreboard = () => {
      if ((scoreboard.keyboard || scoreboard.gamepad) && !actions.menuOpen() && !actions.joinOverlayOpen())
        actions.showScoreboard();
      else actions.hideScoreboard();
    };
    window.addEventListener(
      "blur",
      () => {
        scoreboard.keyboard = scoreboard.gamepad = false;
        refreshScoreboard();
      },
      options,
    );
    this.offController = EventBus.on<ControllerMatchInput>(CONTROLLER_MATCH_INPUT, ({ action, held, pressed }) => {
      if (action === FPS.SCOREBOARD) {
        scoreboard.gamepad = held;
        refreshScoreboard();
      }
      if (!pressed || actions.menuOpen()) return;
      if (action === "menu") {
        actions.openMatchMenu();
        return;
      }
      if (action === FPS.JOIN_GAME && actions.playerState() === "spectator") actions.joinGame();
      if (actions.playerState() !== "spectator" && !actions.isSpectatingTeammate()) return;
      if (action === FPS.WEAPON_3 || action === FPS.WEAPON_NEXT) {
        if (actions.isSpectatingTeammate()) actions.cycleTeammate(1);
        else actions.nextSpectateTarget();
      }
      if (action === FPS.WEAPON_2 || action === FPS.WEAPON_PREV) {
        if (actions.isSpectatingTeammate()) actions.cycleTeammate(-1);
        else actions.prevSpectateTarget();
      }
      if (action === FPS.FIRE) actions.nextSpectateTarget();
      if (action === FPS.JUMP && actions.isChasing()) actions.exitChaseCam();
    });

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
    // and Space/Backspace returns to freefly. In freefly it is ignored until the
    // pointer is locked, so the click that engages mouselook doesn't jump
    // straight into a chase. Watching a player leaves the mouse free, so there
    // a click on the game view itself moves on; clicks on the HUD do not.
    // Middle-click is reserved for "fly down" (crouch), so it is NOT a chase
    // alias here.
    target.addEventListener(
      "mousedown",
      (e: MouseEvent) => {
        if (actions.playerState() !== "spectator") return;
        if (e.button !== 0) return;
        if (!target.pointerLockElement && !(actions.isChasing() && e.target instanceof HTMLCanvasElement)) return;
        e.preventDefault();
        actions.nextSpectateTarget();
      },
      options,
    );

    // ── Escape: the match menu while spectating ──
    // In play and in free flight, Escape releases the mouse and the release
    // opens the menu. Watching a player leaves the mouse free, so there is no
    // release; the key itself opens it. A menu that is open closes itself first.
    target.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.code !== "Escape" || e.repeat || e.defaultPrevented) return;
        if (actions.playerState() !== "spectator" || target.pointerLockElement) return;
        if (
          e.target instanceof HTMLElement &&
          (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
        )
          return;
        if (actions.menuOpen()) return;
        actions.openMatchMenu();
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
        scoreboard.keyboard = true;
        refreshScoreboard();
      },
      options,
    );
    target.addEventListener(
      "keyup",
      (e: KeyboardEvent) => {
        if (e.code !== "Tab") return;
        e.preventDefault();
        scoreboard.keyboard = false;
        refreshScoreboard();
      },
      options,
    );
  }

  /** Remove every listener bind() added. Safe to call when not bound. */
  unbind(): void {
    this.offController?.();
    this.offController = null;
    this.abort?.abort();
    this.abort = null;
  }

  isBound(): boolean {
    return this.abort !== null;
  }
}
