/**
 * CreditsDialog — CREDITS.md from the game's repository, shown in the welcome
 * guide's style. The file is bundled at build time, so the dialog and GitHub
 * always show the same text.
 */

import { InputSystem } from "../../../../engine/input/InputSystem";
import { UIStyles } from "../../../../engine/ui/UIStyles";
import credits from "../../CREDITS.md?raw";
import { button, el } from "../settings/SettingsFields";
import creditsCSS from "../styles/CreditsDialog.css?raw";
import welcomeCSS from "../styles/LobbyWelcomeDialog.css?raw";
import { renderMarkdown } from "./MarkdownLite";

const INPUT_CONTEXT = "fps_credits";

export class CreditsDialog {
  readonly root = el("div", "lobby-guide lobby-credits");
  private readonly body = el("div", "lobby-guide__content lobby-credits__body");
  private readonly close = button("lobby-guide__button lobby-credits__close", "Close");
  private readonly previousFocus = document.activeElement as HTMLElement | null;
  private readonly previousInert: boolean;
  private readonly previousBlur: boolean;
  private readonly previousOverflow = document.body.style.overflow;
  private readonly input = InputSystem.getInstance();
  private disposed = false;

  constructor(
    private readonly options: { background: HTMLElement; onClose(): void },
    source: string = credits,
  ) {
    UIStyles.injectCSS("lobby-guide", welcomeCSS);
    UIStyles.injectCSS("lobby-credits", creditsCSS);
    this.previousInert = options.background.inert;
    this.previousBlur = options.background.classList.contains("lobby-guide-background");
    options.background.inert = true;
    options.background.classList.add("lobby-guide-background");
    document.body.style.overflow = "hidden";

    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "lobby-credits-title");
    const card = el("section", "lobby-guide__card lobby-credits__card");
    const header = el("header", "lobby-guide__header");
    const title = el("h1", "", "Credits & copyrights");
    title.id = "lobby-credits-title";
    header.append(el("span", "lobby-guide__eyebrow", "WASHOI / CREDITS"), title);
    const content = renderMarkdown(source);
    // The file's own "# Credits" title is the dialog's header here.
    if (content.firstElementChild?.tagName === "H1") content.firstElementChild.remove();
    this.body.append(content);
    this.body.tabIndex = 0;
    this.body.setAttribute("aria-label", "Credits");
    const footer = el("footer", "lobby-guide__footer");
    this.close.classList.add("lobby-guide__next");
    this.close.addEventListener("click", () => options.onClose());
    footer.append(this.close);
    card.append(header, this.body, footer);
    this.root.append(card);
    this.root.addEventListener("pointerdown", (event) => {
      if (event.target === this.root) options.onClose();
    });
    document.body.append(this.root);

    this.input.registerContext({ id: INPUT_CONTEXT, blocking: true, actions: [] });
    this.input.pushContext(INPUT_CONTEXT);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    document.addEventListener("focusin", this.onFocus, true);
    this.close.focus();
  }

  private focusables(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>("button, a[href], [tabindex='0']")].filter(
      (node) => !(node as HTMLButtonElement).disabled,
    );
  }

  private readonly onKey = (event: KeyboardEvent) => {
    // Capture keeps lobby hotkeys out; buttons and links still activate.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.options.onClose();
      return;
    }
    if (event.key === "Tab") {
      const keys = this.focusables();
      const index = keys.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      keys[(index + (event.shiftKey ? -1 : 1) + keys.length) % keys.length]?.focus();
    }
    event.stopPropagation();
  };
  private readonly onKeyUp = (event: KeyboardEvent) => event.stopPropagation();
  private readonly onFocus = (event: FocusEvent) => {
    if (!this.root.contains(event.target as Node)) this.close.focus();
  };

  destroy(restoreFocus = true): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    document.removeEventListener("focusin", this.onFocus, true);
    if (this.input.getActiveContext() === INPUT_CONTEXT) this.input.popContext();
    this.options.background.inert = this.previousInert;
    this.options.background.classList.toggle("lobby-guide-background", this.previousBlur);
    document.body.style.overflow = this.previousOverflow;
    this.root.remove();
    if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
