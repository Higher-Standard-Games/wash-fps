/**
 * SpectatorOverlay - Fullscreen spectator mode UI
 *
 * Shows:
 * 1. The join screen on connect: the match handoff's rail and stage, every
 *    step done, over the match, with keys to join or to look around first
 * 2. "SPECTATING: PlayerName" bar during first-person spectate
 * 3. Freefly spectator minimal UI
 */

import { EngineVersion } from "../../../engine/core/EngineVersion";
import { EventBus } from "../../../engine/core/EventBus";
import { LOADING_EVENTS } from "../../../engine/core/LoadingEvents";
import { MapLoader } from "../../../engine/loader/map/MapLoader";
import { createRaisedKey, injectRaisedKeyStyles } from "../../../engine/ui/components/RaisedKey";
import { mapTitle } from "../../../engine/ui/MapTitles";
import { titleLines } from "../../../engine/ui/TransferLoadingView";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { FPS, getActionKeyLabel } from "./FPSActions";
import { MatchStateManager } from "./MatchStateManager";
import matchMenuCss from "./styles/MatchMenu.css?raw";

import "../../../engine/ui/components/styles/ConnectingOverlay.css";

export type SpectatorMode = "join-overlay" | "freefly" | "first-person" | "hidden";

export class SpectatorOverlay {
  private container: HTMLElement;
  private joinOverlay: HTMLElement;
  private spectatingBar: HTMLElement;
  private spectatingNameEl: HTMLElement;
  private freeflyCue: HTMLElement;
  private mode: SpectatorMode = "hidden";

  private onJoinGameCallback: ((teamId?: string) => void) | null = null;
  private onSpectateCallback: (() => void) | null = null;
  private joinKeys: HTMLElement;
  private hintEl: HTMLElement;
  private modeEl: HTMLElement;
  private titleEl: HTMLElement;
  private mapEl: HTMLElement;
  private shotEl: HTMLElement;
  private unsubscribeHidden: () => void;

  // Reserved for first-person spectating (future)
  private _onNextPlayerCallback: (() => void) | null = null;
  private _onPrevPlayerCallback: (() => void) | null = null;

  constructor() {
    // Main container (always present, visibility controlled by mode)
    this.container = document.createElement("div");
    this.container.id = "spectator-overlay";
    this.container.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 500;
            pointer-events: none;
        `;

    // ── Join screen: the handoff's rail and stage, over the match ──
    injectRaisedKeyStyles();
    UIStyles.injectCSS("fps-match-menu", matchMenuCss);
    this.joinOverlay = el("div", "connecting-overlay connecting-overlay--join");
    this.joinOverlay.id = "spectator-join-overlay";
    this.joinOverlay.setAttribute("role", "dialog");
    this.joinOverlay.setAttribute("aria-label", "Join the match");
    this.joinOverlay.style.display = "none";

    const ambient = el("div", "connecting-overlay__ambient-word", "LIVE");
    ambient.setAttribute("aria-hidden", "true");

    const rail = el("aside", "connecting-overlay__rail");
    const railHeader = el("div", "connecting-overlay__rail-header");
    const railTitle = el("div", "connecting-overlay__rail-title");
    railTitle.append(el("span", "", "YOUR"), el("span", "", "CALL"));
    railHeader.append(
      el("div", "connecting-overlay__brand", "WASHIKI // WASHOI"),
      el("div", "connecting-overlay__rail-kicker", "LIVE MATCH"),
      railTitle,
    );
    // The handoff's steps, all behind you now
    const steps = el("ol", "connecting-overlay__steps");
    ["SERVER", "HANDSHAKE", "MAP LOAD"].forEach((label, index) => {
      const mark = el("span", "connecting-overlay__step-mark");
      mark.setAttribute("aria-hidden", "true");
      const step = el("li", "connecting-overlay__step is-done");
      step.append(
        el("span", "connecting-overlay__step-number", `0${index + 1}`),
        el("span", "connecting-overlay__step-label", label),
        mark,
      );
      steps.appendChild(step);
    });
    const endpoint = el("div", "connecting-overlay__endpoint");
    this.mapEl = el("span", "connecting-overlay__server");
    endpoint.append(el("span", "connecting-overlay__endpoint-label", "MAP"), this.mapEl);
    const version = EngineVersion.getInstance();
    rail.append(
      railHeader,
      steps,
      endpoint,
      el("div", "connecting-overlay__rail-footer", `${version.getEngineName()} // ${version.getVersionString()}`),
    );

    const stage = el("main", "connecting-overlay__stage");
    this.shotEl = el("div", "connecting-overlay__shot");
    this.shotEl.setAttribute("aria-hidden", "true");
    const stageHeader = el("div", "connecting-overlay__stage-header");
    const deco = el("div", "connecting-overlay__deco");
    deco.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 5; index++) deco.appendChild(document.createElement("span"));
    stageHeader.append(el("div", "connecting-overlay__sequence", "LIVE MATCH // IN THE STANDS"), deco);

    const hero = el("div", "connecting-overlay__hero");
    this.modeEl = el("div", "connecting-overlay__kicker");
    this.titleEl = el("h1", "connecting-overlay__title");
    hero.append(
      this.modeEl,
      this.titleEl,
      el("p", "connecting-overlay__lead", "You're in the stands. Join the match, or look around first."),
    );

    const choices = el("section", "spectator-join__choices");
    choices.setAttribute("aria-label", "Join or watch");
    this.joinKeys = el("div", "spectator-join__keys");
    this.hintEl = el("div", "spectator-join__hint");
    choices.append(this.joinKeys, this.hintEl);

    stage.append(this.shotEl, stageHeader, hero, choices);
    this.joinOverlay.append(ambient, rail, stage);
    this.container.appendChild(this.joinOverlay);

    // Shown on connect, before the map has loaded: its name arrives with the load
    this.unsubscribeHidden = EventBus.on(LOADING_EVENTS.HIDDEN, () => {
      if (this.mode === "join-overlay") this.refreshJoinPanel();
    });

    this.refreshJoinPanel();

    // ── Spectating Bar (top center, shows during first-person spec) ──
    this.spectatingBar = document.createElement("div");
    this.spectatingBar.id = "spectator-bar";
    this.spectatingBar.className = "fps-spectator-bar";

    // Prev player button
    const prevBtn = document.createElement("span");
    prevBtn.className = "fps-spectator-bar-nav";
    prevBtn.textContent = "◄ [←]";
    prevBtn.addEventListener("click", () => this._onPrevPlayerCallback?.());
    this.spectatingBar.appendChild(prevBtn);

    const specLabel = document.createElement("span");
    specLabel.className = "fps-spectator-bar-label";
    specLabel.textContent = "SPECTATING";
    this.spectatingBar.appendChild(specLabel);

    this.spectatingNameEl = document.createElement("span");
    this.spectatingNameEl.className = "fps-spectator-bar-name";
    this.spectatingBar.appendChild(this.spectatingNameEl);

    // Next player button
    const nextBtn = document.createElement("span");
    nextBtn.className = "fps-spectator-bar-nav";
    nextBtn.textContent = "[→] ►";
    nextBtn.addEventListener("click", () => this._onNextPlayerCallback?.());
    this.spectatingBar.appendChild(nextBtn);

    this.container.appendChild(this.spectatingBar);

    // ── Freefly cue (left sidebar panel, below weapon list) ─────
    this.freeflyCue = document.createElement("div");
    this.freeflyCue.id = "spectator-freefly-cue";
    this.freeflyCue.className = "fps-spectator-cue";

    // Header: "SPECTATOR"
    const header = document.createElement("div");
    header.className = "fps-spectator-cue-header";
    header.textContent = "SPECTATOR";
    this.freeflyCue.appendChild(header);

    // Divider
    const div = document.createElement("div");
    div.className = "fps-spectator-cue-divider";
    this.freeflyCue.appendChild(div);

    // Dynamic key labels from InputSystem
    const moveKeys = [
      getActionKeyLabel(FPS.MOVE_FORWARD),
      getActionKeyLabel(FPS.MOVE_LEFT),
      getActionKeyLabel(FPS.MOVE_BACKWARD),
      getActionKeyLabel(FPS.MOVE_RIGHT),
    ].join("");
    const sprintKey = getActionKeyLabel(FPS.SPRINT);
    const fireKey = getActionKeyLabel(FPS.FIRE);
    const joinKey2 = getActionKeyLabel(FPS.JOIN_GAME);
    const jumpKey = getActionKeyLabel(FPS.JUMP);
    const crouchKey = getActionKeyLabel(FPS.CROUCH);

    const bindings: [string, string][] = [
      [moveKeys, "Fly"],
      ["MOUSE", "Look"],
      [sprintKey, "Fast"],
      [jumpKey, "Fly Up"],
      [crouchKey, "Fly Down"],
      [fireKey, "Chase Player"],
      [joinKey2, "Join Game"],
      ["ESC", "Menu"],
    ];

    // Split into two columns of 3
    const half = Math.ceil(bindings.length / 2);
    const leftCol = bindings.slice(0, half);
    const rightCol = bindings.slice(half);

    const grid = document.createElement("div");
    grid.className = "fps-spectator-cue-grid";

    for (let i = 0; i < half; i++) {
      // Left column
      const lk = document.createElement("div");
      lk.className = "fps-spectator-key";
      lk.textContent = leftCol[i][0];
      const la = document.createElement("div");
      la.className = "fps-spectator-action";
      la.textContent = leftCol[i][1];

      // Vertical divider cell
      const sep = document.createElement("div");
      sep.className = "fps-spectator-sep";

      // Right column
      const rk = document.createElement("div");
      rk.className = "fps-spectator-key";
      rk.textContent = rightCol[i]?.[0] ?? "";
      const ra = document.createElement("div");
      ra.className = "fps-spectator-action";
      ra.textContent = rightCol[i]?.[1] ?? "";

      grid.appendChild(lk);
      grid.appendChild(la);
      grid.appendChild(sep);
      grid.appendChild(rk);
      grid.appendChild(ra);
    }

    this.freeflyCue.appendChild(grid);
    this.container.appendChild(this.freeflyCue);

    document.body.appendChild(this.container);
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Set the current spectator mode — controls what UI is visible
   */
  public setMode(mode: SpectatorMode): void {
    this.mode = mode;

    // Hide everything first
    this.joinOverlay.style.display = "none";
    this.spectatingBar.style.display = "none";
    this.freeflyCue.style.display = "none";

    // The join screen covers the HUD, as the loading screen before it does
    this.container.style.zIndex = mode === "join-overlay" ? "960" : "500";

    switch (mode) {
      case "join-overlay":
        this.refreshJoinPanel();
        this.joinOverlay.style.display = "";
        break;
      case "freefly":
        this.freeflyCue.style.display = "flex";
        break;
      case "first-person":
        this.spectatingBar.style.display = "flex";
        break;
      case "hidden":
        break;
    }
  }

  public getMode(): SpectatorMode {
    return this.mode;
  }

  /** Set the target player name for first-person spectating bar */
  public setSpectatingTarget(playerName: string): void {
    this.spectatingNameEl.textContent = playerName;
  }

  // ── Callbacks ───────────────────────────────────────────────

  public onJoinGame(cb: (teamId?: string) => void): void {
    this.onJoinGameCallback = cb;
  }
  public onSpectate(cb: () => void): void {
    this.onSpectateCallback = cb;
  }

  // Suppress TS unused warnings for future callbacks
  public onNextPlayer(cb: () => void): void {
    this._onNextPlayerCallback = cb;
    if (this._onNextPlayerCallback !== null) {
    } // TS hack to mark as read
  }
  public onPrevPlayer(cb: () => void): void {
    this._onPrevPlayerCallback = cb;
    if (this._onPrevPlayerCallback !== null) {
    } // TS hack to mark as read
  }

  // ── Cleanup ─────────────────────────────────────────────────

  public destroy(): void {
    this.unsubscribeHidden();
    this.container.remove();
  }

  // ── Private ─────────────────────────────────────────────────

  private refreshJoinPanel(): void {
    const state = MatchStateManager.getInstance();
    const map = MapLoader.getInstance().getCurrentMap() ?? "";
    const name = map ? (mapTitle(map) ?? map) : "Live match";
    this.modeEl.textContent = state.gametypeName ? state.gametypeName.toUpperCase() : "LIVE MATCH";
    const lines = titleLines(name.toUpperCase());
    this.titleEl.replaceChildren(...lines.map((line) => el("span", "", line)));
    this.titleEl.style.setProperty("--co-title-chars", String(Math.max(6, ...lines.map((line) => line.length))));
    this.mapEl.textContent = map || "—";
    // A map with no levelshot installed keeps the stage's own gradient
    if (map) this.shotEl.style.setProperty("--co-shot", `url("/data/levelshots/${encodeURIComponent(map)}.jpg")`);
    else this.shotEl.style.removeProperty("--co-shot");

    const joinKey = getActionKeyLabel(FPS.JOIN_GAME);
    const spectate = createRaisedKey({ label: "Spectate", hint: "Fly around", variants: ["cream"] });
    spectate.addEventListener("click", () => this.onSpectateCallback?.());

    // Team-ness comes from the gametype, not from the presence of team scores:
    // those ship with both sides populated in every gametype, so a free-for-all
    // read as a team game and every player landed in the spectator list.
    if (state.teamBased) {
      // Sides by how full they are, not by colour: colour is allegiance, and
      // your side is pink whichever one you pick.
      const sizes = { udon: 0, soba: 0 };
      for (const team of Object.values(state.playerTeams ?? {})) {
        if (team === "udon" || team === "soba") sizes[team]++;
      }
      const side = (teamId: "udon" | "soba", label: string) => {
        const count = sizes[teamId];
        const key = createRaisedKey({
          label,
          hint: count === 0 ? "Empty" : count === 1 ? "1 player" : `${count} players`,
          variants: ["cta"],
        });
        key.addEventListener("click", () => this.onJoinGameCallback?.(teamId));
        return key;
      };
      this.joinKeys.replaceChildren(side("udon", "Join Udon"), side("soba", "Join Soba"), spectate);
      this.hintEl.textContent = `${joinKey} puts you on the side with fewer players`;
    } else {
      const join = createRaisedKey({ label: "Join game", hint: `or press ${joinKey}`, variants: ["cta"] });
      join.addEventListener("click", () => this.onJoinGameCallback?.());
      this.joinKeys.replaceChildren(join, spectate);
      this.hintEl.textContent = "";
    }
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
