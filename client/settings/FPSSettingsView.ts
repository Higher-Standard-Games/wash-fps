/**
 * The settings screen: Controls, Gameplay, Video and Audio, saved as you go.
 *
 * The page keys belong to the view. The lobby and the in-game overlay both move
 * them into a rail with `takePageNav()`; without a host they sit above the page.
 */

import { AudioManager } from "../../../../engine/AudioManager";
import { Cvar } from "../../../../engine/core/Cvar";
import { EventBus } from "../../../../engine/core/EventBus";
import { registerFpsDisplayCvar } from "../../../../engine/core/FpsDisplaySettings";
import {
  failedPreferenceKeys,
  flushPreferenceWrites,
  PREFERENCE_STORAGE_EVENT,
} from "../../../../engine/core/PreferenceStorage";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { MovementVars } from "../../../../engine/movement/MovementVars";
import { NetGraph } from "../../../../engine/network/client/NetGraph";
import { RenderVars } from "../../../../engine/rendering/RenderVars";
import { createRaisedKey, injectRaisedKeyStyles, setRaisedKeyText } from "../../../../engine/ui/components/RaisedKey";
import { UIStyles } from "../../../../engine/ui/UIStyles";
import { registerFPSActions } from "../FPSActions";
import { registerPlayerModelVisualCvars } from "../PlayerModelVisualSettings";
import "../Crosshair";
import { AudioPage } from "./AudioPage";
import { ControlsPage } from "./ControlsPage";
import settingsCss from "./FPSSettingsView.css?raw";
import { GameplayPage } from "./GameplayPage";
import { el } from "./SettingsFields";
import { resetPage, SETTINGS_PAGES, type SettingsPageId } from "./SettingsModel";
import { VideoPage } from "./VideoPage";

/** How long a reset key stays armed for its second press. */
const ARM_MS = 3500;

export class FPSSettingsView {
  private readonly root: HTMLElement;
  private readonly nav: HTMLElement;
  private readonly title: HTMLElement;
  private readonly ghost: HTMLElement;
  private readonly refreshers: Array<() => void> = [];
  private readonly panes = new Map<SettingsPageId, HTMLElement>();
  private readonly pageKeys = new Map<SettingsPageId, HTMLButtonElement>();
  private readonly controls: ControlsPage;
  private readonly gameplay: GameplayPage;
  private readonly video: VideoPage;
  private readonly resetPageKey: HTMLButtonElement;
  private readonly resetAllKey: HTMLButtonElement;
  private page: SettingsPageId = "controls";
  private armed: "page" | "all" | null = null;
  private armTimer = 0;
  private toastEl: HTMLElement | null = null;
  private toastTimer = 0;
  private cancelScheduledRedraw: (() => void) | null = null;
  private readonly savedLabel = el("span", "fps-set-saved", "Saved as you go");
  private readonly unsubscribeStorage: () => void;
  private readonly onKeyDown = (event: KeyboardEvent) => {
    // Immediate: the screen's own Esc listens on the same node, and would close it too
    if (event.code === "Escape" && this.page === "video" && this.isShown() && this.video.closeSection()) {
      event.stopImmediatePropagation();
    }
  };

  constructor() {
    injectRaisedKeyStyles();
    UIStyles.injectCSS("fps-settings-view", settingsCss);
    Cvar.init();
    registerFpsDisplayCvar();
    registerPlayerModelVisualCvars();
    RenderVars.getInstance();
    AudioManager.getInstance();
    MovementVars.getInstance();
    NetGraph.init();
    registerFPSActions();
    InputSystem.getInstance().loadBindingsFromStorage();

    this.root = el("div", "lobby__page fps-set-view");

    const light = el("div", "lobby__light");
    light.setAttribute("aria-hidden", "true");
    for (const tone of ["violet", "deep", "accent"]) light.append(el("div", `lobby__orb lobby__orb--${tone}`));
    this.ghost = el("div", "lobby__ghost fps-set-ghost");
    this.ghost.setAttribute("aria-hidden", "true");

    const head = el("header", "fps-set-head");
    const heading = el("div");
    this.title = el("h1", "lobby__title fps-set-head__title");
    heading.append(el("div", "lobby__kicker", "Settings"), this.title);
    const side = el("div", "fps-set-head__side");
    this.resetPageKey = createRaisedKey({ label: "Reset page", variants: ["sm", "cream", "inline", "reset"] });
    this.resetAllKey = createRaisedKey({ label: "Reset all", variants: ["sm", "cream", "inline", "reset"] });
    this.resetPageKey.addEventListener("click", () => this.armOrRun("page"));
    this.resetAllKey.addEventListener("click", () => this.armOrRun("all"));
    this.savedLabel.setAttribute("role", "status");
    this.savedLabel.setAttribute("aria-live", "polite");
    const refreshStorage = () => {
      const failed = failedPreferenceKeys().some((key) =>
        ["engine_cvars", "engine.movementVars", "shag_keybindings", "ui_theme_mode"].includes(key),
      );
      this.savedLabel.textContent = failed ? "Session only · could not save" : "Saved as you go";
      this.savedLabel.classList.toggle("is-session-only", failed);
      this.savedLabel.title = failed
        ? "Changes work now, but could not be saved in this browser. They may be lost on reload."
        : "Settings are saved in this browser as you change them.";
    };
    this.unsubscribeStorage = EventBus.on(PREFERENCE_STORAGE_EVENT, refreshStorage);
    refreshStorage();
    side.append(this.savedLabel, this.resetPageKey, this.resetAllKey);
    head.append(heading, side);

    this.nav = el("nav", "fps-set-pages");
    this.nav.setAttribute("aria-label", "Settings pages");
    for (const page of SETTINGS_PAGES) {
      const key = createRaisedKey({ label: page.title, hint: page.hint, variants: ["nav", "page"] });
      key.dataset.settingsPage = page.id;
      key.addEventListener("click", () => this.showPage(page.id));
      this.nav.append(key);
      this.pageKeys.set(page.id, key);
    }

    const host = {
      addRefresh: (refresh: () => void) => this.refreshers.push(refresh),
      changed: () => this.redraw(),
      changedSoon: () => this.scheduleRedraw(),
      toast: (...parts: Array<string | { bold: string }>) => this.toast(...parts),
      leftLimit: () => this.root.getBoundingClientRect().left + 60,
    };
    this.controls = new ControlsPage(host);
    this.gameplay = new GameplayPage(host);
    this.video = new VideoPage(host);
    const audio = new AudioPage(host);

    const panes = el("div", "fps-set-panes");
    for (const [id, content] of [
      ["controls", this.controls.root],
      ["gameplay", this.gameplay.root],
      ["video", this.video.root],
      ["audio", audio.root],
    ] as const) {
      const pane = el("section", "fps-set-pane");
      pane.dataset.settingsPane = id;
      pane.append(content);
      panes.append(pane);
      this.panes.set(id, pane);
    }

    this.root.append(light, this.ghost, head, this.nav, panes);
    document.addEventListener("keydown", this.onKeyDown, true);
    this.showPage("controls");
    this.redraw();
  }

  public getElement(): HTMLElement {
    return this.root;
  }

  /**
   * Hand the page keys to a host that shows them elsewhere, such as the lobby's
   * rail. The view keeps driving them.
   */
  public takePageNav(): HTMLElement {
    this.root.classList.add("fps-set-view--nav-outside");
    return this.nav;
  }

  public get currentPage(): SettingsPageId {
    return this.page;
  }

  /** Read every value again: something may have changed them from the console. */
  public async refresh(): Promise<void> {
    this.redraw();
  }

  public showPage(id: SettingsPageId): void {
    if (this.page === "controls" && id !== "controls") this.controls.deactivate();
    this.page = id;
    const page = SETTINGS_PAGES.find((item) => item.id === id) ?? SETTINGS_PAGES[0];
    for (const [pageId, pane] of this.panes) pane.hidden = pageId !== id;
    for (const [pageId, key] of this.pageKeys) {
      if (pageId === id) key.setAttribute("aria-current", "page");
      else key.removeAttribute("aria-current");
    }
    this.title.textContent = page.title;
    this.ghost.textContent = page.ghost;
    this.disarm();
    this.redraw();
  }

  public destroy(): void {
    this.cancelScheduledRedraw?.();
    this.cancelScheduledRedraw = null;
    flushPreferenceWrites();
    this.unsubscribeStorage();
    this.disarm();
    window.clearTimeout(this.toastTimer);
    this.toastEl?.remove();
    this.toastEl = null;
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.controls.destroy();
    this.gameplay.destroy();
    this.video.destroy();
  }

  private redraw(): void {
    for (const refresh of this.refreshers) refresh();
  }

  private scheduleRedraw(): void {
    if (this.cancelScheduledRedraw) return;
    const redraw = () => {
      this.cancelScheduledRedraw = null;
      this.redraw();
    };
    if (typeof window.requestAnimationFrame === "function") {
      const frame = window.requestAnimationFrame(redraw);
      this.cancelScheduledRedraw = () => window.cancelAnimationFrame(frame);
    } else {
      const timer = window.setTimeout(redraw, 16);
      this.cancelScheduledRedraw = () => window.clearTimeout(timer);
    }
  }

  private isShown(): boolean {
    return this.root.isConnected && this.root.offsetParent !== null;
  }

  // ── Resets ask once: the first press arms the key, a second within a few seconds does it ──

  private armOrRun(which: "page" | "all"): void {
    if (this.armed === which) {
      this.disarm();
      if (which === "page") {
        resetPage(this.page);
        this.toast(
          { bold: SETTINGS_PAGES.find((page) => page.id === this.page)?.title ?? "Page" },
          " back to defaults",
        );
      } else {
        for (const page of SETTINGS_PAGES) resetPage(page.id);
        this.toast({ bold: "Everything" }, " back to defaults");
      }
      this.redraw();
      return;
    }
    this.disarm();
    this.armed = which;
    const key = which === "page" ? this.resetPageKey : this.resetAllKey;
    key.classList.add("is-armed");
    const pageTitle = SETTINGS_PAGES.find((page) => page.id === this.page)?.title ?? "";
    setRaisedKeyText(key, which === "all" ? "Sure? Everything" : `Sure? ${pageTitle}`);
    this.armTimer = window.setTimeout(() => this.disarm(), ARM_MS);
  }

  private disarm(): void {
    this.armed = null;
    window.clearTimeout(this.armTimer);
    this.resetPageKey.classList.remove("is-armed");
    this.resetAllKey.classList.remove("is-armed");
    setRaisedKeyText(this.resetPageKey, "Reset page");
    setRaisedKeyText(this.resetAllKey, "Reset all");
  }

  private toast(...parts: Array<string | { bold: string }>): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl?.remove();
    const toast = el("div", "fps-set-toast");
    toast.setAttribute("role", "status");
    for (const part of parts) toast.append(typeof part === "string" ? part : el("b", "", part.bold));
    document.body.append(toast);
    this.toastEl = toast;
    this.toastTimer = window.setTimeout(() => {
      toast.remove();
      if (this.toastEl === toast) this.toastEl = null;
    }, 2700);
  }
}
