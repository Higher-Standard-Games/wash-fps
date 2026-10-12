import { PLAYTEST_RETURN_KEY } from "../../../../../engine/editor/EditorLauncher";
import { MapLoader } from "../../../../../engine/loader/map/MapLoader";
import { PlayerProfile } from "../../../../../engine/player/PlayerProfile";
import { createRaisedKey, injectRaisedKeyStyles } from "../../../../../engine/ui/components/RaisedKey";
import { mapTitle } from "../../../../../engine/ui/MapTitles";
import { GameDialogPanel } from "../../../../../engine/ui/panels/GameDialogPanel";
import { UIStyles } from "../../../../../engine/ui/UIStyles";
import { MatchStateManager } from "../../MatchStateManager";
import { buildRailBrand } from "../../RailBrand";
import matchMenuCss from "../../styles/MatchMenu.css?raw";

/** A key a mode adds to the match menu (the Loadout key). */
export interface MatchMenuModeKey {
  id: string;
  label: string;
  hint: string;
  onClick: () => void;
}

/**
 * FPSPauseMenu - the Esc menu: the lobby's gold rail, drawn over the match.
 *
 * The match does not stop for it; the rail says so, and says which match it
 * is. Its keys are the lobby's: the first one lit is what Esc most likely
 * came for (Resume in play, Join for a spectator), and Leave sits apart at
 * the foot.
 */
export class FPSPauseMenu extends GameDialogPanel {
  private onResumeCallback: (() => void) | null = null;
  private onSettingsCallback: (() => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private onSpectateCallback: (() => void) | null = null;
  private onJoinGameCallback: ((teamId?: string) => void) | null = null;
  private readonly resumeKey: HTMLButtonElement;
  private readonly spectateKey: HTMLButtonElement;
  private readonly joinKeys: HTMLElement;
  /** Keys the mode brings (Loadout), right under Resume. */
  private readonly modeKeys: HTMLElement;
  private readonly kickerEl: HTMLElement;
  private readonly nameEl: HTMLElement;

  constructor() {
    // The menu mirrors pointer-lock state (unlocked = shown, Resume re-locks).
    // A backdrop click would hide it WITHOUT re-locking the pointer, stranding
    // the player with a free cursor and no menu, so only the keys and Esc close it.
    super({ title: "Match menu", closeOnBackdrop: false, showCloseButton: false });
    injectRaisedKeyStyles();
    UIStyles.injectCSS("fps-match-menu", matchMenuCss);

    this.backdrop.className = "game-dialog-backdrop fps-match-menu";
    this.dialog.className = "fps-match-menu__rail";
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-label", "Match menu");
    this.dialog.tabIndex = -1;
    this.dialog.replaceChildren();

    const kanji = element("div", "fps-match-menu__kanji", "闘");
    kanji.setAttribute("aria-hidden", "true");

    const head = element("div", "fps-match-menu__head");
    this.kickerEl = element("div", "fps-match-menu__kicker");
    head.append(
      buildRailBrand("fps-match-menu__logo"),
      this.kickerEl,
      element("p", "fps-match-menu__note", "The match keeps going while you're here."),
    );

    this.resumeKey = this.key("Resume", "Back to the fight", () => {
      this.close();
      this.onResumeCallback?.();
    });
    this.joinKeys = element("div", "fps-match-menu__join");
    this.joinKeys.hidden = true;
    this.modeKeys = element("div", "fps-match-menu__mode");
    this.modeKeys.hidden = true;
    const settingsKey = this.key("Settings", "Controls and video", () => this.onSettingsCallback?.());
    this.spectateKey = this.key("Spectate", "Watch the match", () => {
      this.close();
      this.onSpectateCallback?.();
    });
    this.spectateKey.hidden = true;

    const keys = element("nav", "fps-match-menu__keys");
    keys.setAttribute("aria-label", "Match");
    keys.append(this.resumeKey, this.joinKeys, this.modeKeys, settingsKey, this.spectateKey);

    const foot = element("div", "fps-match-menu__foot");
    const plate = element("div", "fps-match-menu__plate");
    this.nameEl = element("span", "fps-match-menu__name");
    plate.append(this.nameEl, element("span", "fps-match-menu__where", "In a match"));
    let returningToEditor = false;
    try {
      returningToEditor = !!sessionStorage.getItem(PLAYTEST_RETURN_KEY);
    } catch {
      // Editor return metadata is optional when browser storage is blocked.
    }
    const leave = createRaisedKey({
      label: returningToEditor ? "Return to Editor" : "Leave match",
      hint: returningToEditor ? "Resume your map" : "Back to the lobby",
      variants: ["sm", "cream"],
    });
    leave.addEventListener("click", () => {
      this.close();
      this.onDisconnectCallback?.();
    });
    foot.append(plate, leave);

    this.dialog.append(kanji, head, keys, foot);
  }

  public override open(): void {
    const state = MatchStateManager.getInstance();
    const map = MapLoader.getInstance().getCurrentMap();
    const where = map ? (mapTitle(map) ?? map) : "";
    this.kickerEl.textContent = [state.gametypeName, where].filter(Boolean).join(" · ");
    this.nameEl.textContent = PlayerProfile.load().name;
    this.lightFirstKey();
    super.open();
    // Tab starts inside the menu rather than behind it
    this.dialog.focus({ preventScroll: true });
  }

  public onResume(callback: () => void): void {
    this.onResumeCallback = callback;
  }

  public onSettings(callback: () => void): void {
    this.onSettingsCallback = callback;
  }

  public onDisconnect(callback: () => void): void {
    this.onDisconnectCallback = callback;
  }

  public onGoSpectate(callback: () => void): void {
    this.onSpectateCallback = callback;
  }

  public onJoinGame(callback: (teamId?: string) => void): void {
    this.onJoinGameCallback = callback;
  }

  public setSpectateVisible(visible: boolean): void {
    this.spectateKey.hidden = !visible;
  }

  public setResumeVisible(visible: boolean): void {
    this.resumeKey.hidden = !visible;
    this.lightFirstKey();
  }

  public setJoinVisible(visible: boolean): void {
    this.joinKeys.hidden = !visible;
    if (visible) this.refreshJoinKeys();
    this.lightFirstKey();
  }

  /**
   * The keys the mode brings, right under Resume (and Join): today the Loadout
   * key, in modes with kits. A key closes the menu before it acts. None hides the slot.
   */
  public setModeKeys(keys: readonly MatchMenuModeKey[]): void {
    this.modeKeys.replaceChildren(
      ...keys.map((modeKey) => {
        const key = this.key(modeKey.label, modeKey.hint, () => {
          this.close();
          modeKey.onClick();
        });
        key.dataset.modeKey = modeKey.id;
        return key;
      }),
    );
    this.modeKeys.hidden = keys.length === 0;
  }

  private key(label: string, hint: string, onClick: () => void): HTMLButtonElement {
    const key = createRaisedKey({ label, hint, variants: ["nav"] });
    key.addEventListener("click", onClick);
    return key;
  }

  /** The first key on the rail is inked, as the lobby inks the page you're on. */
  private lightFirstKey(): void {
    const keys = [this.resumeKey, ...this.joinKeys.querySelectorAll<HTMLButtonElement>(".raised-key")];
    const first = keys.find((key) => !key.hidden && !key.closest("[hidden]"));
    for (const key of keys) key.classList.toggle("raised-key--ink", key === first);
  }

  /** Players on each side right now, spectators excluded. */
  private teamSizes(): { udon: number; soba: number } {
    const teams = MatchStateManager.getInstance().playerTeams ?? {};
    let udon = 0;
    let soba = 0;
    for (const team of Object.values(teams)) {
      if (team === "udon") udon++;
      else if (team === "soba") soba++;
    }
    return { udon, soba };
  }

  private static describeSide(count: number): string {
    if (count === 0) return "Empty";
    return count === 1 ? "1 player" : `${count} players`;
  }

  private refreshJoinKeys(): void {
    // Team-ness comes from the gametype, not from the presence of team scores:
    // those ship with both sides populated in every gametype, so a free-for-all
    // read as a team game and every player landed in the spectator list.
    if (!MatchStateManager.getInstance().teamBased) {
      this.joinKeys.replaceChildren(
        this.key("Join game", "Enter the arena", () => {
          this.close();
          this.onJoinGameCallback?.();
        }),
      );
      return;
    }

    // How full each side is, rather than what colour it is: colour is
    // allegiance (your side is pink whichever it is), and size is what bears
    // on the choice, since picking the bigger side gets you moved to the smaller.
    const sizes = this.teamSizes();
    const side = (teamId: "udon" | "soba", name: string, count: number) =>
      this.key(`Join ${name}`, FPSPauseMenu.describeSide(count), () => {
        this.close();
        this.onJoinGameCallback?.(teamId);
      });
    this.joinKeys.replaceChildren(side("udon", "Udon", sizes.udon), side("soba", "Soba", sizes.soba));
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
