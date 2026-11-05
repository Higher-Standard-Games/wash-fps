/**
 * SpectatorOverlay - Fullscreen spectator mode UI
 *
 * Shows:
 * 1. The join screen on connect: the match handoff's rail and stage, every
 *    step done, over the match, with keys to join or to look around first
 * 2. "SPECTATING: PlayerName" bar during first-person spectate
 * 3. Freefly spectator minimal UI
 */

import { Cvar } from "../../../engine/core/Cvar";
import { EventBus } from "../../../engine/core/EventBus";
import { LOADING_EVENTS } from "../../../engine/core/LoadingEvents";
import { INPUT_DEVICE_CHANGED, InputDevice } from "../../../engine/input/InputDevice";
import { PLAY_CHANGE } from "../../../engine/input/PlayCapture";
import { MapLoader } from "../../../engine/loader/map/MapLoader";
import { buildTwinLight, buildTwinRail, TWIN_ROOT_CLASS, type TwinRail } from "../../../engine/ui/components/LobbyTwin";
import { createRaisedKey, injectRaisedKeyStyles } from "../../../engine/ui/components/RaisedKey";
import { mapTitle } from "../../../engine/ui/MapTitles";
import { UINavigation } from "../../../engine/ui/navigation/UINavigation";
import { titleLines } from "../../../engine/ui/TransferLoadingView";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { FPS, getActionKeyLabel } from "./FPSActions";
import { MatchStateManager } from "./MatchStateManager";
import matchMenuCss from "./styles/MatchMenu.css?raw";

import "../../../engine/ui/components/styles/ConnectingOverlay.css";

export type SpectatorMode = "join-overlay" | "freefly" | "first-person" | "hidden";

export class SpectatorOverlay {
  private offNavigation: (() => void) | null = null;
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
  private rail: TwinRail;
  private shotEl: HTMLElement;
  private unsubscribeHidden: () => void;
  private unsubscribeDevice: () => void;
  private cueGrid: HTMLElement;
  private prevKey: HTMLElement;
  private nextKey: HTMLElement;
  private cueSignature = "";
  private readonly refreshControls = () => {
    const controller = InputDevice.getInstance().current === "gamepad";
    const moveKeys = controller
      ? getActionKeyLabel(FPS.MOVE_FORWARD)
      : [FPS.MOVE_FORWARD, FPS.MOVE_LEFT, FPS.MOVE_BACKWARD, FPS.MOVE_RIGHT].map(getActionKeyLabel).join("");
    const bindings: [string, string][] = [
      [moveKeys, "Fly"],
      [controller ? (Cvar.getBool("in_pad_swap") ? "Left stick" : "Right stick") : "MOUSE", "Look"],
      [getActionKeyLabel(FPS.SPRINT), "Fast"],
      [getActionKeyLabel(FPS.JUMP), "Fly Up"],
      [getActionKeyLabel(FPS.CROUCH), "Fly Down"],
      [getActionKeyLabel(FPS.FIRE), "Chase Player"],
      [getActionKeyLabel(FPS.JOIN_GAME), "Join Game"],
      [controller ? "Menu" : "ESC", "Menu"],
    ];
    const prev = controller ? getActionKeyLabel(FPS.WEAPON_PREV) : "←";
    const next = controller ? getActionKeyLabel(FPS.WEAPON_NEXT) : "→";
    const signature = JSON.stringify([bindings, prev, next]);
    if (signature === this.cueSignature) return;
    this.cueSignature = signature;
    this.prevKey.textContent = prev;
    this.nextKey.textContent = next;
    const half = Math.ceil(bindings.length / 2);
    this.cueGrid.replaceChildren();
    for (let i = 0; i < half; i++) {
      for (const pair of [bindings[i], bindings[i + half]]) {
        if (pair)
          this.cueGrid.append(el("div", "fps-spectator-key", pair[0]), el("div", "fps-spectator-action", pair[1]));
      }
    }
    if (this.mode === "join-overlay") this.refreshJoinPanel();
  };

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
    this.joinOverlay = el("div", `connecting-overlay connecting-overlay--join ${TWIN_ROOT_CLASS}`);
    this.joinOverlay.id = "spectator-join-overlay";
    this.joinOverlay.setAttribute("role", "dialog");
    this.joinOverlay.setAttribute("aria-label", "Join the match");
    this.joinOverlay.style.display = "none";

    // The lobby's rail: the handoff's steps, all behind you now
    this.rail = buildTwinRail({
      label: "Join the match",
      steps: ["Server", "Handshake", "Map load"],
      context: "Live match",
    });
    this.rail.setSteps(["done", "done", "done"]);

    const stage = el("main", "twin__stage connecting-overlay__stage");
    this.shotEl = el("div", "connecting-overlay__shot");
    this.shotEl.setAttribute("aria-hidden", "true");

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

    stage.append(this.shotEl, hero, choices);
    this.joinOverlay.append(buildTwinLight(), this.rail.rail, stage);
    this.container.appendChild(this.joinOverlay);

    // Shown on connect, before the map has loaded: its name arrives with the load
    this.unsubscribeHidden = EventBus.on(LOADING_EVENTS.HIDDEN, () => {
      if (this.mode === "join-overlay") this.refreshJoinPanel();
    });

    this.refreshJoinPanel();

    // ── Spectating bar (above the bottom HUD, during first-person spec) ──
    // Whom you are watching, between the keys that step to the previous and
    // next player
    this.spectatingBar = el("div", "fps-spectator-bar");
    this.spectatingBar.id = "spectator-bar";

    const prevBtn = el("span", "fps-spectator-bar-nav");
    prevBtn.title = "Previous player";
    this.prevKey = el("span", "fps-spectator-bar-key", "←");
    prevBtn.appendChild(this.prevKey);
    prevBtn.addEventListener("click", () => this._onPrevPlayerCallback?.());

    const who = el("div", "fps-spectator-bar-who");
    this.spectatingNameEl = el("span", "fps-spectator-bar-name");
    who.append(el("span", "fps-spectator-bar-label", "Spectating"), this.spectatingNameEl);

    const nextBtn = el("span", "fps-spectator-bar-nav");
    nextBtn.title = "Next player (→, or click the view)";
    this.nextKey = el("span", "fps-spectator-bar-key", "→");
    nextBtn.appendChild(this.nextKey);
    nextBtn.addEventListener("click", () => this._onNextPlayerCallback?.());

    this.spectatingBar.append(prevBtn, who, nextBtn);
    this.container.appendChild(this.spectatingBar);

    // ── Freefly cue (bottom left, above the HUD) ─────
    this.freeflyCue = document.createElement("div");
    this.freeflyCue.id = "spectator-freefly-cue";
    this.freeflyCue.className = "fps-spectator-cue";

    const header = document.createElement("div");
    header.className = "fps-spectator-cue-header";
    header.textContent = "SPECTATOR";
    this.freeflyCue.appendChild(header);

    this.cueGrid = el("div", "fps-spectator-cue-grid");
    this.freeflyCue.appendChild(this.cueGrid);
    this.container.appendChild(this.freeflyCue);

    document.body.appendChild(this.container);
    this.refreshControls();
    this.unsubscribeDevice = EventBus.on(INPUT_DEVICE_CHANGED, this.refreshControls);
    document.addEventListener(PLAY_CHANGE, this.refreshControls);
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Set the current spectator mode — controls what UI is visible
   */
  public setMode(mode: SpectatorMode): void {
    this.offNavigation?.();
    this.offNavigation = null;
    this.mode = mode;
    this.refreshControls();

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
        this.offNavigation = UINavigation.getInstance().push({ root: this.joinOverlay });
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
    this.refreshControls();
    // Called every snapshot; the name almost never changes.
    if (this.spectatingNameEl.textContent !== playerName) this.spectatingNameEl.textContent = playerName;
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
    this.offNavigation?.();
    this.unsubscribeHidden();
    this.unsubscribeDevice();
    document.removeEventListener(PLAY_CHANGE, this.refreshControls);
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
    this.rail.setFact("map", "Map", map || "—");
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
