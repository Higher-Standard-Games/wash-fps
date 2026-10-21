import { writePreference } from "../../../engine/core/PreferenceStorage";
import { InputSystem } from "../../../engine/input/InputSystem";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { DEFAULT_FPS_MOVEMENT_CONFIG } from "../simulation/MovementProfile";
import terms from "../TERMS.md?raw";
import { renderMarkdown } from "./credits/MarkdownLite";
import { FPS } from "./FPSActions";
import settingsCSS from "./settings/FPSSettingsView.css?raw";
import { createInputDiagram } from "./settings/InputDiagram";
import { button, el } from "./settings/SettingsFields";
import { codesFor, inputName, SETTINGS_ACTIONS } from "./settings/SettingsModel";
import welcomeCSS from "./styles/LobbyWelcomeDialog.css?raw";

export const WELCOME_PREFERENCE = "washoi.welcome.hideAutomatically";
/** Holds the TERMS_VERSION the player agreed to. */
export const TERMS_PREFERENCE = "washoi.terms.agreed";
/** The terms' "Last Updated" date: new terms ask again. */
export const TERMS_VERSION = /\*\*Last Updated:\*\*\s*(.+)/.exec(terms)?.[1].trim() ?? "";

export function termsAgreed(): boolean {
  try {
    return localStorage.getItem(TERMS_PREFERENCE) === TERMS_VERSION;
  } catch {
    return false;
  }
}

/** The guide opens by itself unless the player turned that off; never before they agreed to the terms. */
export function welcomeIsHidden(): boolean {
  try {
    return termsAgreed() && localStorage.getItem(WELCOME_PREFERENCE) === "true";
  } catch {
    return false;
  }
}

function bindings(action: string): HTMLElement {
  const root = el("span", "lobby-guide__bindings");
  const codes = codesFor(action);
  if (!codes.length) root.textContent = `${action === FPS.JUMP ? "Jump" : "Crouch"} is unbound — open keyboard setup`;
  const labels = [
    ...new Set(
      [...codes.filter((code) => !code.includes(":")), ...codes.filter((code) => code.includes(":"))].map(inputName),
    ),
  ];
  labels.forEach((label, index) => {
    if (index) root.append(el("span", "", " / "));
    root.append(el("kbd", "lobby-guide__keycap", label));
  });
  return root;
}

export class LobbyWelcomeDialog {
  readonly root = el("div", "lobby-guide");
  private readonly card = el("section", "lobby-guide__card");
  private readonly panels: HTMLElement[] = [];
  private readonly tabs: HTMLButtonElement[] = [];
  private readonly next = button("lobby-guide__button lobby-guide__next");
  private readonly setup = button("lobby-guide__button lobby-guide__setup", "Go to keyboard setup");
  private readonly preference = el("label", "lobby-guide__preference");
  private readonly saveStatus = el("span", "lobby-guide__save-status");
  private readonly agree = document.createElement("input");
  private readonly agreeLabel = el("label", "lobby-guide__preference lobby-guide__agree");
  /** Until the terms are agreed to, the guide stays on its first page and cannot be closed. */
  private agreed = termsAgreed();
  private readonly previousFocus = document.activeElement as HTMLElement | null;
  private readonly previousInert: boolean;
  private readonly previousBlur: boolean;
  private readonly previousOverflow = document.body.style.overflow;
  private tab = 0;
  private disposed = false;
  private readonly input = InputSystem.getInstance();

  constructor(
    private readonly options: {
      background: HTMLElement;
      tab?: number;
      secondaryTip: number;
      onClose(): void;
      onSetup(): void;
      onTab(tab: number): void;
    },
  ) {
    UIStyles.injectCSS("fps-settings-view", settingsCSS);
    UIStyles.injectCSS("lobby-guide", welcomeCSS);
    this.previousInert = options.background.inert;
    this.previousBlur = options.background.classList.contains("lobby-guide-background");
    options.background.inert = true;
    options.background.classList.add("lobby-guide-background");
    document.body.style.overflow = "hidden";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Welcome to Washoi ALPHA, terms of service and movement tips");
    const header = el("header", "lobby-guide__header");
    header.append(el("span", "lobby-guide__eyebrow", "WASHOI / READY TO PLAY"), el("h1", "", "Find your flow."));
    const tablist = el("div", "lobby-guide__tabs");
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Welcome guide");
    const content = el("div", "lobby-guide__content");
    const names = ["Welcome & terms", "Your keys", "Tip of the day"];
    names.forEach((name, index) => {
      const tab = button("lobby-guide__tab", `${index + 1}. ${name}`);
      tab.id = `lobby-guide-tab-${index}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `lobby-guide-panel-${index}`);
      tab.addEventListener("click", () => this.select(index));
      const panel = el("section", "lobby-guide__panel");
      panel.id = `lobby-guide-panel-${index}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      this.tabs.push(tab);
      this.panels.push(panel);
      tablist.append(tab);
      content.append(panel);
    });
    this.buildPages(options.secondaryTip);
    const footer = el("footer", "lobby-guide__footer");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = welcomeIsHidden();
    checkbox.addEventListener("change", () => {
      const saved = writePreference(WELCOME_PREFERENCE, String(checkbox.checked));
      this.saveStatus.textContent = saved
        ? ""
        : checkbox.checked
          ? "This choice couldn't be saved. The guide may appear next time."
          : "This choice couldn't be saved. Automatic display may still be disabled next time.";
    });
    const prefText = el("span");
    prefText.append(el("span", "", "Don't show this again"), el("small", "", "Reopen this guide with ? in the lobby."));
    this.preference.append(checkbox, prefText);
    this.saveStatus.setAttribute("role", "status");
    this.setup.addEventListener("click", options.onSetup);
    this.next.addEventListener("click", () => {
      if (!this.agreed) return;
      if (this.tab === 2) options.onClose();
      else this.select(this.tab + 1);
    });
    footer.append(this.setup, this.agreeLabel, this.preference, this.next);
    this.card.append(header, tablist, content, this.saveStatus, footer);
    this.root.append(this.card);
    document.body.append(this.root);
    this.input.registerContext({ id: "fps_welcome", blocking: true, actions: [] });
    this.input.pushContext("fps_welcome");
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    document.addEventListener("focusin", this.onFocus, true);
    this.select(this.agreed ? (options.tab ?? 0) : 0);
    this.tabs[this.tab].focus();
  }

  private buildPages(secondary: number): void {
    this.panels[0].append(
      el("h2", "", "Fast movement. Loud weapons. One more round."),
      el(
        "p",
        "",
        "Welcome to Washoi ALPHA, an arena shooter where movement makes the difference. Before your first match, please read our terms: everything played on our servers is public.",
      ),
    );
    const termsBox = el("div", "lobby-guide__terms");
    termsBox.tabIndex = 0;
    termsBox.setAttribute("aria-label", "Terms of service");
    termsBox.append(renderMarkdown(terms, { headingOffset: 2 }));
    this.agree.type = "checkbox";
    this.agree.checked = this.agreed;
    this.agree.addEventListener("change", () => {
      this.agreed = this.agree.checked;
      const saved = writePreference(TERMS_PREFERENCE, this.agreed ? TERMS_VERSION : "");
      this.saveStatus.textContent =
        saved || !this.agreed ? "" : "Your agreement couldn't be saved. The terms will be asked again next time.";
      this.select(this.tab);
    });
    this.agreeLabel.append(this.agree, el("span", "", "I agree to the terms of service"));
    this.panels[0].append(termsBox);
    const diagram = createInputDiagram();
    diagram.refresh();
    const preview = el("div", "fps-set-view lobby-guide__preview");
    const keyboard = el("div", "lobby-guide__keyboard"),
      mouse = el("div", "lobby-guide__mouse");
    keyboard.append(el("h3", "", "Keyboard"), diagram.board);
    mouse.append(el("h3", "", "Mouse"), diagram.mouse);
    preview.append(keyboard, mouse);
    preview.setAttribute("aria-hidden", "true");
    const summary = el("ul", "lobby-guide__binding-summary");
    for (const action of SETTINGS_ACTIONS.filter((a) => a.group !== "other")) {
      const codes = codesFor(action.id);
      summary.append(el("li", "", `${action.name}: ${codes.length ? codes.map(inputName).join(" / ") : "Unbound"}`));
    }
    this.panels[1].append(
      el("h2", "", "Your controls, ready to go."),
      el("p", "lobby-guide__muted", "You can change these in keyboard setup."),
      preview,
      summary,
    );
    const tips = this.panels[2];
    tips.append(el("h2", "", "Did you know?"));
    const slide = el("article", "lobby-guide__lesson"),
      slideText = el("p");
    slideText.append(
      `Crouchsliding is essential. Build at least ${DEFAULT_FPS_MOVEMENT_CONFIG.slideMinSpeed} u/s, then press `,
      bindings(FPS.CROUCH),
      " to slide and carry your speed through the arena.",
    );
    slide.append(el("h3", "", "Keep your momentum"), slideText);
    const wall = el("article", "lobby-guide__lesson"),
      wallText = el("p");
    wallText.append(
      "Can't quite reach that ledge? While airborne beside a wall, hold ",
      bindings(FPS.JUMP),
      " to charge a wall jump, then release to push off.",
    );
    wall.append(el("h3", "", "Reach a little higher"), wallText);
    const extra = el("article", "lobby-guide__lesson lobby-guide__lesson--extra"),
      extraText = el("p");
    if (secondary === 0)
      extraText.append("Hold ", bindings(FPS.CROUCH), " before landing from a high fall to soften the impact.");
    else
      extraText.append(
        "Jump out of a crouchslide with ",
        bindings(FPS.JUMP),
        " to turn the slide into another boosted jump.",
      );
    extra.append(el("h3", "", secondary === 0 ? "Land softer" : "Chain your movement"), extraText);
    tips.append(slide, wall, extra, el("small", "lobby-guide__muted", "Tips describe standard movement rules."));
  }

  private select(tab: number): void {
    this.tab = tab;
    this.options.onTab(tab);
    this.tabs.forEach((key, index) => {
      key.disabled = index > 0 && !this.agreed;
      key.setAttribute("aria-selected", String(index === tab));
      key.tabIndex = index === tab ? 0 : -1;
      this.panels[index].hidden = index !== tab;
    });
    this.next.textContent = tab === 2 ? "Close" : "Next »";
    this.next.disabled = !this.agreed;
    this.next.title = this.agreed ? "" : "Agree to the terms to continue";
    this.next.setAttribute(
      "aria-label",
      tab === 2 ? "Close welcome guide" : `Next: ${tab === 0 ? "Your keys" : "Tip of the day"}`,
    );
    this.setup.hidden = tab !== 1;
    this.preference.hidden = tab !== 2;
    this.agreeLabel.hidden = tab !== 0;
    this.card.querySelector(".lobby-guide__content")!.scrollTop = 0;
  }

  private focusables(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>("button, input, [tabindex='0']")].filter(
      (el) => !el.closest("[hidden]") && !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
    );
  }
  private readonly onKey = (event: KeyboardEvent) => {
    // Capture keeps lobby hotkeys out; explicitly preserve native control activation.
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target instanceof HTMLElement &&
      (event.target instanceof HTMLButtonElement ||
        (event.key === " " && event.target.matches('input[type="checkbox"]')))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) event.target.click();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.agreed) this.options.onClose();
      return;
    }
    if (event.key === "Tab") {
      const keys = this.focusables(),
        index = keys.indexOf(document.activeElement as HTMLElement);
      const next = keys[(index + (event.shiftKey ? -1 : 1) + keys.length) % keys.length];
      event.preventDefault();
      next?.focus();
    } else if (event.target instanceof HTMLElement && event.target.getAttribute("role") === "tab") {
      const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (direction || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (!this.agreed) return;
        this.select(event.key === "Home" ? 0 : event.key === "End" ? 2 : (this.tab + direction + 3) % 3);
        this.tabs[this.tab].focus();
      }
    }
    // Native button/checkbox defaults still run; lobby keyboard handlers do not.
    event.stopPropagation();
  };
  private readonly onKeyUp = (event: KeyboardEvent) => event.stopPropagation();
  private readonly onFocus = (event: FocusEvent) => {
    if (!this.root.contains(event.target as Node)) this.tabs[this.tab].focus();
  };

  destroy(restoreFocus = true): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    document.removeEventListener("focusin", this.onFocus, true);
    if (this.input.getActiveContext() === "fps_welcome") this.input.popContext();
    this.options.background.inert = this.previousInert;
    this.options.background.classList.toggle("lobby-guide-background", this.previousBlur);
    document.body.style.overflow = this.previousOverflow;
    this.root.remove();
    if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
