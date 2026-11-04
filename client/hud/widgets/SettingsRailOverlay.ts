import { createRaisedKey } from "../../../../../engine/ui/components/RaisedKey";
import { GameDialogPanel } from "../../../../../engine/ui/panels/GameDialogPanel";
import { UIStyles } from "../../../../../engine/ui/UIStyles";
import { buildRailBrand } from "../../RailBrand";
import { FPSSettingsView } from "../../settings/FPSSettingsView";
import matchMenuCss from "../../styles/MatchMenu.css?raw";

/**
 * The settings screen over a match, laid out as the lobby lays it out: the
 * page keys on the match menu's gold rail, the page on the stage beside it.
 * Back closes it. The kicker (gametype · map) comes from whoever opens it:
 * `FPSSettingsOverlay` in the browser game, the native client's match menu
 * in the lobby page (`client/native/MatchSettings.ts`), which has no map loaded.
 */
export class SettingsRailOverlay extends GameDialogPanel {
  private readonly settingsView: FPSSettingsView;
  private readonly kickerEl: HTMLElement;

  constructor() {
    super({ title: "Settings", closeOnBackdrop: false, showCloseButton: false });
    UIStyles.injectCSS("fps-match-menu", matchMenuCss);
    this.settingsView = new FPSSettingsView({ inMatch: true });

    this.backdrop.className = "game-dialog-backdrop fps-match-menu fps-match-menu--settings";
    // A lobby rail as well, so the page keys stack and fold as they do there
    this.dialog.className = "fps-match-menu__rail lobby__rail";
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-label", "Settings");
    this.dialog.tabIndex = -1;
    this.dialog.replaceChildren();

    const head = element("div", "fps-match-menu__head");
    this.kickerEl = element("div", "fps-match-menu__kicker");
    head.append(buildRailBrand("fps-match-menu__logo"), this.kickerEl);

    const foot = element("div", "fps-match-menu__foot");
    const back = createRaisedKey({ label: "Back", hint: "To the match menu", variants: ["sm", "cream"] });
    back.addEventListener("click", () => this.close());
    foot.append(back);

    this.dialog.append(
      head,
      element("div", "fps-match-menu__label", "Settings"),
      this.settingsView.takePageNav(),
      foot,
    );

    const stage = element("main", "fps-match-menu__stage");
    stage.append(this.settingsView.getElement());
    this.backdrop.append(stage);
  }

  /** Opens over the match named by `kicker` (gametype · map). */
  public openWith(kicker: string): void {
    this.kickerEl.textContent = kicker;
    void this.settingsView.refresh();
    super.open();
    this.dialog.focus({ preventScroll: true });
  }

  public override open(): void {
    this.openWith(this.kickerEl.textContent ?? "");
  }

  public override destroy(): void {
    this.settingsView.destroy();
    super.destroy();
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
