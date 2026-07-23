import { AudioManager } from "../../../../engine/AudioManager";
import { Cvar } from "../../../../engine/core/Cvar";
import {
  hexToRgbCvar,
  registerPlayerModelVisualCvars,
  rgbCvarToHexValue,
} from "../PlayerModelVisualSettings";
import { InputSystem } from "../../../../engine/input/InputSystem";
import type { InputBinding, MouseButton } from "../../../../engine/input/InputTypes";
import { MovementVars } from "../../../../engine/movement/MovementVars";
import { NetGraph } from "../../../../engine/network/client/NetGraph";
import { RenderVars } from "../../../../engine/rendering/RenderVars";
import { UIStyles } from "../../../../engine/ui/UIStyles";
import { MangaPanelDialog } from "../hud/widgets/MangaPanelDialog";
import { FPS } from "../FPSActions";
import "../Crosshair";
import settingsCss from "./FPSSettingsView.css?raw";

type SettingsTabId = "graphics" | "audio" | "controls" | "interface";
type ControlsSubtabId = "keyboard-mouse" | "controller";
type ActionCategoryId = "movement" | "weapons" | "combat" | "actions";
type ColorPreset = { label: string; value: string };

type SimpleBinding =
  | { key: string }
  | { mouseButton: MouseButton }
  | { scrollDirection: "up" | "down" };

type SlotKind = "key" | "mouse" | "wheel";

interface SlotDefinition {
  id: string;
  display: string;
  kind: SlotKind;
  binding: SimpleBinding;
  width?: number;
}

interface ActionDefinition {
  id: string;
  category: ActionCategoryId;
  label: string;
  keyTag: string;
  defaults: InputBinding[];
}

class SettingsConfirmDialog extends MangaPanelDialog {
  public get body(): HTMLElement {
    return this.bodyEl;
  }

  public get footer(): HTMLElement {
    return this.footerEl;
  }
}

const COLOR_PRESETS: ColorPreset[] = [
  { label: "Cyan", value: "00E7FF" },
  { label: "Green", value: "00FF66" },
  { label: "Amber", value: "FFB400" },
  { label: "White", value: "F4F7FF" },
  { label: "Magenta", value: "FF4FD8" },
  { label: "Red", value: "FF3355" },
];

const ACTION_CATEGORIES: Array<{ id: ActionCategoryId; label: string }> = [
  { id: "movement", label: "Movement" },
  { id: "weapons", label: "Weapons" },
  { id: "combat", label: "Combat" },
  { id: "actions", label: "Actions" },
];

const ACTION_DEFINITIONS: ActionDefinition[] = [
  { id: FPS.MOVE_FORWARD, category: "movement", label: "Forward", keyTag: "FWD", defaults: [{ key: "KeyW" }] },
  { id: FPS.MOVE_BACKWARD, category: "movement", label: "Back", keyTag: "BACK", defaults: [{ key: "KeyS" }] },
  { id: FPS.MOVE_LEFT, category: "movement", label: "Left", keyTag: "LEFT", defaults: [{ key: "KeyA" }] },
  { id: FPS.MOVE_RIGHT, category: "movement", label: "Right", keyTag: "RIGHT", defaults: [{ key: "KeyD" }] },
  { id: FPS.JUMP, category: "movement", label: "Jump", keyTag: "JUMP", defaults: [{ key: "Space" }] },
  {
    id: FPS.CROUCH,
    category: "movement",
    label: "Crouch",
    keyTag: "CRCH",
    defaults: [{ mouseButton: "middle" }, { key: "KeyC" }, { key: "ControlLeft" }, { key: "ControlRight" }],
  },
  {
    id: FPS.SPRINT,
    category: "movement",
    label: "Sprint",
    keyTag: "SPR",
    defaults: [{ key: "ShiftLeft" }, { key: "ShiftRight" }],
  },
  { id: FPS.WEAPON_1, category: "weapons", label: "Blade", keyTag: "BLD", defaults: [{ key: "Digit1" }, { key: "KeyQ" }] },
  { id: FPS.WEAPON_2, category: "weapons", label: "Primary Weapon", keyTag: "PRI", defaults: [{ key: "Digit2" }] },
  { id: FPS.WEAPON_3, category: "weapons", label: "Secondary Weapon", keyTag: "SEC", defaults: [{ key: "Digit3" }] },
  { id: FPS.WEAPON_4, category: "weapons", label: "Weapon 4", keyTag: "W4", defaults: [] },
  { id: FPS.WEAPON_5, category: "weapons", label: "Weapon 5", keyTag: "W5", defaults: [] },
  { id: FPS.WEAPON_6, category: "weapons", label: "Weapon 6", keyTag: "W6", defaults: [] },
  { id: FPS.WEAPON_7, category: "weapons", label: "Weapon 7", keyTag: "W7", defaults: [] },
  { id: FPS.WEAPON_8, category: "weapons", label: "Weapon 8", keyTag: "W8", defaults: [] },
  { id: FPS.WEAPON_9, category: "weapons", label: "Weapon 9", keyTag: "W9", defaults: [] },
  {
    id: FPS.WEAPON_NEXT,
    category: "weapons",
    label: "Next Weapon",
    keyTag: "NEXT",
    defaults: [{ scrollDirection: "down" }],
  },
  {
    id: FPS.WEAPON_PREV,
    category: "weapons",
    label: "Previous Weapon",
    keyTag: "PREV",
    defaults: [{ scrollDirection: "up" }],
  },
  { id: FPS.FIRE, category: "combat", label: "Fire", keyTag: "FIRE", defaults: [{ mouseButton: "left" }] },
  { id: FPS.AIM, category: "combat", label: "Aim", keyTag: "AIM", defaults: [{ mouseButton: "right" }] },
  { id: FPS.RELOAD, category: "combat", label: "Reload", keyTag: "RLD", defaults: [{ key: "KeyR" }] },
  { id: FPS.USE, category: "combat", label: "Use", keyTag: "USE", defaults: [{ key: "KeyF" }] },
  { id: FPS.SCOREBOARD, category: "actions", label: "Scoreboard", keyTag: "SCR", defaults: [{ key: "Tab" }] },
  { id: FPS.CHAT, category: "actions", label: "Chat", keyTag: "CHAT", defaults: [{ key: "KeyT" }] },
  { id: FPS.READY, category: "actions", label: "Ready", keyTag: "RDY", defaults: [{ key: "F4" }] },
  { id: FPS.JOIN_GAME, category: "actions", label: "Join Game", keyTag: "JOIN", defaults: [{ key: "KeyJ" }] },
  { id: FPS.CONSOLE, category: "actions", label: "Console", keyTag: "CON", defaults: [{ key: "Backquote" }] },
];

const ACTION_LOOKUP = new Map(ACTION_DEFINITIONS.map((action) => [action.id, action]));

const KEYBOARD_ROWS: SlotDefinition[][] = [
  [
    { id: "Escape", display: "Esc", kind: "key", binding: { key: "Escape" }, width: 1.2 },
    { id: "F1", display: "F1", kind: "key", binding: { key: "F1" } },
    { id: "F2", display: "F2", kind: "key", binding: { key: "F2" } },
    { id: "F3", display: "F3", kind: "key", binding: { key: "F3" } },
    { id: "F4", display: "F4", kind: "key", binding: { key: "F4" } },
    { id: "F5", display: "F5", kind: "key", binding: { key: "F5" } },
    { id: "F6", display: "F6", kind: "key", binding: { key: "F6" } },
    { id: "F7", display: "F7", kind: "key", binding: { key: "F7" } },
    { id: "F8", display: "F8", kind: "key", binding: { key: "F8" } },
    { id: "F9", display: "F9", kind: "key", binding: { key: "F9" } },
    { id: "F10", display: "F10", kind: "key", binding: { key: "F10" } },
    { id: "F11", display: "F11", kind: "key", binding: { key: "F11" } },
    { id: "F12", display: "F12", kind: "key", binding: { key: "F12" } },
  ],
  [
    { id: "Backquote", display: "`", kind: "key", binding: { key: "Backquote" } },
    { id: "Digit1", display: "1", kind: "key", binding: { key: "Digit1" } },
    { id: "Digit2", display: "2", kind: "key", binding: { key: "Digit2" } },
    { id: "Digit3", display: "3", kind: "key", binding: { key: "Digit3" } },
    { id: "Digit4", display: "4", kind: "key", binding: { key: "Digit4" } },
    { id: "Digit5", display: "5", kind: "key", binding: { key: "Digit5" } },
    { id: "Digit6", display: "6", kind: "key", binding: { key: "Digit6" } },
    { id: "Digit7", display: "7", kind: "key", binding: { key: "Digit7" } },
    { id: "Digit8", display: "8", kind: "key", binding: { key: "Digit8" } },
    { id: "Digit9", display: "9", kind: "key", binding: { key: "Digit9" } },
    { id: "Digit0", display: "0", kind: "key", binding: { key: "Digit0" } },
    { id: "Minus", display: "-", kind: "key", binding: { key: "Minus" } },
    { id: "Equal", display: "=", kind: "key", binding: { key: "Equal" } },
    { id: "Backspace", display: "Backspace", kind: "key", binding: { key: "Backspace" }, width: 2 },
  ],
  [
    { id: "Tab", display: "Tab", kind: "key", binding: { key: "Tab" }, width: 1.5 },
    { id: "KeyQ", display: "Q", kind: "key", binding: { key: "KeyQ" } },
    { id: "KeyW", display: "W", kind: "key", binding: { key: "KeyW" } },
    { id: "KeyE", display: "E", kind: "key", binding: { key: "KeyE" } },
    { id: "KeyR", display: "R", kind: "key", binding: { key: "KeyR" } },
    { id: "KeyT", display: "T", kind: "key", binding: { key: "KeyT" } },
    { id: "KeyY", display: "Y", kind: "key", binding: { key: "KeyY" } },
    { id: "KeyU", display: "U", kind: "key", binding: { key: "KeyU" } },
    { id: "KeyI", display: "I", kind: "key", binding: { key: "KeyI" } },
    { id: "KeyO", display: "O", kind: "key", binding: { key: "KeyO" } },
    { id: "KeyP", display: "P", kind: "key", binding: { key: "KeyP" } },
    { id: "BracketLeft", display: "[", kind: "key", binding: { key: "BracketLeft" } },
    { id: "BracketRight", display: "]", kind: "key", binding: { key: "BracketRight" } },
    { id: "Backslash", display: "\\", kind: "key", binding: { key: "Backslash" }, width: 1.5 },
  ],
  [
    { id: "CapsLock", display: "Caps", kind: "key", binding: { key: "CapsLock" }, width: 1.8 },
    { id: "KeyA", display: "A", kind: "key", binding: { key: "KeyA" } },
    { id: "KeyS", display: "S", kind: "key", binding: { key: "KeyS" } },
    { id: "KeyD", display: "D", kind: "key", binding: { key: "KeyD" } },
    { id: "KeyF", display: "F", kind: "key", binding: { key: "KeyF" } },
    { id: "KeyG", display: "G", kind: "key", binding: { key: "KeyG" } },
    { id: "KeyH", display: "H", kind: "key", binding: { key: "KeyH" } },
    { id: "KeyJ", display: "J", kind: "key", binding: { key: "KeyJ" } },
    { id: "KeyK", display: "K", kind: "key", binding: { key: "KeyK" } },
    { id: "KeyL", display: "L", kind: "key", binding: { key: "KeyL" } },
    { id: "Semicolon", display: ";", kind: "key", binding: { key: "Semicolon" } },
    { id: "Quote", display: "'", kind: "key", binding: { key: "Quote" } },
    { id: "Enter", display: "Enter", kind: "key", binding: { key: "Enter" }, width: 2.2 },
  ],
  [
    { id: "ShiftLeft", display: "Shift", kind: "key", binding: { key: "ShiftLeft" }, width: 2.4 },
    { id: "KeyZ", display: "Z", kind: "key", binding: { key: "KeyZ" } },
    { id: "KeyX", display: "X", kind: "key", binding: { key: "KeyX" } },
    { id: "KeyC", display: "C", kind: "key", binding: { key: "KeyC" } },
    { id: "KeyV", display: "V", kind: "key", binding: { key: "KeyV" } },
    { id: "KeyB", display: "B", kind: "key", binding: { key: "KeyB" } },
    { id: "KeyN", display: "N", kind: "key", binding: { key: "KeyN" } },
    { id: "KeyM", display: "M", kind: "key", binding: { key: "KeyM" } },
    { id: "Comma", display: ",", kind: "key", binding: { key: "Comma" } },
    { id: "Period", display: ".", kind: "key", binding: { key: "Period" } },
    { id: "Slash", display: "/", kind: "key", binding: { key: "Slash" } },
    { id: "ShiftRight", display: "Shift", kind: "key", binding: { key: "ShiftRight" }, width: 2.8 },
    { id: "ArrowUp", display: "Up", kind: "key", binding: { key: "ArrowUp" } },
  ],
  [
    { id: "ControlLeft", display: "Ctrl", kind: "key", binding: { key: "ControlLeft" }, width: 1.5 },
    { id: "MetaLeft", display: "Win", kind: "key", binding: { key: "MetaLeft" }, width: 1.2 },
    { id: "AltLeft", display: "Alt", kind: "key", binding: { key: "AltLeft" }, width: 1.2 },
    { id: "Space", display: "Space", kind: "key", binding: { key: "Space" }, width: 5.6 },
    { id: "AltRight", display: "Alt", kind: "key", binding: { key: "AltRight" }, width: 1.2 },
    { id: "MetaRight", display: "Fn", kind: "key", binding: { key: "MetaRight" }, width: 1.2 },
    { id: "ContextMenu", display: "Menu", kind: "key", binding: { key: "ContextMenu" }, width: 1.2 },
    { id: "ControlRight", display: "Ctrl", kind: "key", binding: { key: "ControlRight" }, width: 1.5 },
    { id: "ArrowLeft", display: "Left", kind: "key", binding: { key: "ArrowLeft" } },
    { id: "ArrowDown", display: "Down", kind: "key", binding: { key: "ArrowDown" } },
    { id: "ArrowRight", display: "Right", kind: "key", binding: { key: "ArrowRight" } },
  ],
];

const MOUSE_SLOTS: SlotDefinition[] = [
  { id: "left", display: "Left Click", kind: "mouse", binding: { mouseButton: "left" } },
  { id: "right", display: "Right Click", kind: "mouse", binding: { mouseButton: "right" } },
  { id: "middle", display: "Middle Click", kind: "mouse", binding: { mouseButton: "middle" } },
  { id: "wheel-up", display: "Wheel Up", kind: "wheel", binding: { scrollDirection: "up" } },
  { id: "wheel-down", display: "Wheel Down", kind: "wheel", binding: { scrollDirection: "down" } },
];

type RefreshCallback = () => void | Promise<void>;
type ResetCallback = () => void | Promise<void>;

function isKeyboardBinding(binding: InputBinding): binding is { key: string } {
  return typeof binding.key === "string" && !binding.modifiers;
}

function isMouseBinding(binding: InputBinding): binding is { mouseButton: MouseButton } {
  return typeof binding.mouseButton === "string" && !binding.modifiers;
}

function isWheelBinding(binding: InputBinding): binding is { scrollDirection: "up" | "down" } {
  return typeof binding.scrollDirection === "string" && !binding.modifiers;
}

function toSimpleBinding(binding: InputBinding): SimpleBinding | null {
  if (isKeyboardBinding(binding)) return { key: binding.key };
  if (isMouseBinding(binding)) return { mouseButton: binding.mouseButton };
  if (isWheelBinding(binding)) return { scrollDirection: binding.scrollDirection };
  return null;
}

function simpleBindingKey(binding: SimpleBinding): string {
  if ("key" in binding) return `key:${binding.key}`;
  if ("mouseButton" in binding) return `mouse:${binding.mouseButton}`;
  return `wheel:${binding.scrollDirection}`;
}

function bindingsEqual(a: InputBinding[], b: InputBinding[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((binding, index) => {
    const other = b[index];
    return binding.key === other.key && binding.mouseButton === other.mouseButton && binding.scrollDirection === other.scrollDirection;
  });
}

function normalizeBindings(bindings: InputBinding[]): InputBinding[] {
  const seen = new Set<string>();
  const normalized: InputBinding[] = [];

  for (const binding of bindings) {
    const simple = toSimpleBinding(binding);
    if (!simple) continue;
    const key = simpleBindingKey(simple);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...simple });
  }

  return normalized;
}

function slotMatchesBinding(slot: SlotDefinition, binding: InputBinding): boolean {
  const simple = toSimpleBinding(binding);
  if (!simple) return false;
  return simpleBindingKey(simple) === simpleBindingKey(slot.binding);
}

function buttonClass(base: string, active: boolean): string {
  return active ? `${base} ${base}--active` : base;
}

async function getFullscreenState(): Promise<boolean> {
  if (window.electronAPI?.window?.isFullscreen) {
    try {
      return await window.electronAPI.window.isFullscreen();
    } catch {
      return false;
    }
  }

  return !!document.fullscreenElement;
}

async function setFullscreenState(next: boolean): Promise<void> {
  if (window.electronAPI?.window?.setFullscreen) {
    window.electronAPI.window.setFullscreen(next);
    return;
  }

  if (next) {
    await document.documentElement.requestFullscreen().catch(() => {});
  } else if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  }
}

export class FPSSettingsView {
  private readonly root: HTMLElement;
  private readonly input = InputSystem.getInstance();
  private readonly refreshCallbacks: RefreshCallback[] = [];
  private readonly tabResets = new Map<SettingsTabId, ResetCallback[]>();
  private readonly panelByTab = new Map<SettingsTabId, HTMLElement>();
  private readonly tabButtons = new Map<SettingsTabId, HTMLButtonElement>();
  private readonly keyButtons = new Map<string, HTMLButtonElement>();
  private readonly mouseHotspots = new Map<string, HTMLButtonElement>();
  private readonly mouseCards = new Map<string, HTMLButtonElement>();

  private currentTab: SettingsTabId = "graphics";
  private controlsSubtabButtons = new Map<ControlsSubtabId, HTMLButtonElement>();
  private controlsSubtabPanels = new Map<ControlsSubtabId, HTMLElement>();
  private selectedSlotId: string | null = null;
  private contextMenu: HTMLElement | null = null;
  private contextMenuCategory: ActionCategoryId = "movement";
  private outsideClickHandler: ((event: MouseEvent) => void) | null = null;
  private fullscreenHandler: (() => void) | null = null;
  private resetDialog: SettingsConfirmDialog | null = null;

  constructor() {
    UIStyles.injectCSS("fps-settings-view", settingsCss);
    Cvar.init();
    registerPlayerModelVisualCvars();
    RenderVars.getInstance();
    AudioManager.getInstance();
    MovementVars.getInstance();
    NetGraph.init();
    this.input.loadBindingsFromStorage();

    this.root = document.createElement("div");
    this.root.className = "fps-settings-shell";

    const tabBar = document.createElement("div");
    tabBar.className = "fps-settings-top-tabs";
    this.root.appendChild(tabBar);

    const content = document.createElement("div");
    content.className = "fps-settings-panels";
    this.root.appendChild(content);

    const actionBar = document.createElement("div");
    actionBar.className = "fps-settings-actions";

    const resetTabBtn = document.createElement("button");
    resetTabBtn.className = "fps-btn";
    resetTabBtn.textContent = "Reset Tab";
    resetTabBtn.addEventListener("click", () => this.confirmResetCurrentTab());
    actionBar.appendChild(resetTabBtn);

    const resetAllBtn = document.createElement("button");
    resetAllBtn.className = "fps-btn fps-btn--primary";
    resetAllBtn.textContent = "Reset All";
    resetAllBtn.addEventListener("click", () => this.confirmResetAll());
    actionBar.appendChild(resetAllBtn);

    this.root.appendChild(actionBar);

    this.createTab(tabBar, content, "graphics", "Graphics", this.buildGraphicsTab());
    this.createTab(tabBar, content, "audio", "Audio", this.buildAudioTab());
    this.createTab(tabBar, content, "controls", "Controls", this.buildControlsTab());
    this.createTab(tabBar, content, "interface", "Interface", this.buildInterfaceTab());
    this.switchTab("graphics");

    this.outsideClickHandler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (this.contextMenu?.contains(target)) return;
      if (this.root.contains(target) && (target as HTMLElement).closest("[data-settings-slot]")) return;
      this.closeContextMenu();
    };
    document.addEventListener("mousedown", this.outsideClickHandler, true);

    this.fullscreenHandler = () => {
      void this.refresh();
    };
    document.addEventListener("fullscreenchange", this.fullscreenHandler);
  }

  public getElement(): HTMLElement {
    return this.root;
  }

  public async refresh(): Promise<void> {
    for (const callback of this.refreshCallbacks) {
      await callback();
    }

    this.refreshSlotVisuals();
  }

  public async resetCurrentTab(): Promise<void> {
    const resets = this.tabResets.get(this.currentTab) ?? [];
    for (const reset of resets) {
      await reset();
    }
    await this.refresh();
  }

  public async resetAll(): Promise<void> {
    for (const tabId of ["graphics", "audio", "controls", "interface"] as const) {
      const resets = this.tabResets.get(tabId) ?? [];
      for (const reset of resets) {
        await reset();
      }
    }
    await this.refresh();
  }

  private confirmResetCurrentTab(): void {
    const resets = this.tabResets.get(this.currentTab) ?? [];
    if (resets.length === 0) {
      return;
    }

    const tabLabel = this.getTabLabel(this.currentTab);
    this.openResetDialog(
      `Reset ${tabLabel}?`,
      `This will restore the ${tabLabel.toLowerCase()} settings on this screen to their defaults immediately.`,
      "Reset Tab",
      () => {
        void this.resetCurrentTab();
      },
    );
  }

  private confirmResetAll(): void {
    this.openResetDialog(
      "Reset all settings?",
      "This will restore graphics, audio, controls, and interface settings to their defaults immediately, including key bindings.",
      "Reset All",
      () => {
        void this.resetAll();
      },
    );
  }

  public destroy(): void {
    this.closeContextMenu();
    this.resetDialog?.destroy();
    this.resetDialog = null;
    if (this.outsideClickHandler) {
      document.removeEventListener("mousedown", this.outsideClickHandler, true);
    }
    if (this.fullscreenHandler) {
      document.removeEventListener("fullscreenchange", this.fullscreenHandler);
    }
  }

  private createTab(tabBar: HTMLElement, content: HTMLElement, id: SettingsTabId, label: string, panel: HTMLElement): void {
    const button = document.createElement("button");
    button.className = "fps-settings-tab-btn";
    button.textContent = label;
    button.addEventListener("click", () => this.switchTab(id));
    tabBar.appendChild(button);
    this.tabButtons.set(id, button);

    panel.classList.add("fps-settings-panel");
    content.appendChild(panel);
    this.panelByTab.set(id, panel);
  }

  private getTabLabel(tabId: SettingsTabId): string {
    switch (tabId) {
      case "graphics":
        return "Graphics";
      case "audio":
        return "Audio";
      case "controls":
        return "Controls";
      case "interface":
        return "Interface";
    }
  }

  private switchTab(tabId: SettingsTabId): void {
    this.currentTab = tabId;

    for (const [id, button] of this.tabButtons) {
      button.className = buttonClass("fps-settings-tab-btn", id === tabId);
    }

    for (const [id, panel] of this.panelByTab) {
      panel.classList.toggle("fps-settings-panel--active", id === tabId);
    }

    this.closeContextMenu();
  }

  private buildGraphicsTab(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "fps-settings-panel fps-settings-panel--active";

    const grid = document.createElement("div");
    grid.className = "fps-settings-grid";
    panel.appendChild(grid);

    const display = this.createSection("Display");
    this.addFullscreenToggle(display.rows, "graphics");
    grid.appendChild(display.section);

    const graphics = this.createSection("Graphics");
    this.addBloomToggle(graphics.rows, "graphics");
    this.addCvarSlider(graphics.rows, "Glow", "r_glow", "graphics", { min: 0, max: 2, step: 0.05 });
    this.addCvarToggle(graphics.rows, "Reflections (SSR)", "r_ssr", "graphics");
    this.addCvarSlider(graphics.rows, "SSR Strength", "r_ssr_strength", "graphics", { min: 0, max: 2, step: 0.05 });
    this.addCvarSlider(graphics.rows, "Anisotropy", "r_anisotropy", "graphics", { min: 1, max: 16, step: 1 });
    grid.appendChild(graphics.section);


    const playerVisibility = this.createSection("Player Visibility");
    this.addRgbColorPickerRow(playerVisibility.rows, "Team Udon", "cl_team_alpha_color", "graphics");
    this.addRgbColorPickerRow(playerVisibility.rows, "Team Soba", "cl_team_beta_color", "graphics");
    this.addRgbColorPickerRow(playerVisibility.rows, "FFA Enemy", "cl_team_ffa_color", "graphics");
    this.addCvarToggle(playerVisibility.rows, "Outline", "cl_player_outline", "graphics");
    this.addRgbColorPickerRow(playerVisibility.rows, "Udon Outline", "cl_team_alpha_outline_color", "graphics");
    this.addRgbColorPickerRow(playerVisibility.rows, "Soba Outline", "cl_team_beta_outline_color", "graphics");
    this.addRgbColorPickerRow(playerVisibility.rows, "FFA Outline", "cl_team_ffa_outline_color", "graphics");
    this.addCvarSlider(playerVisibility.rows, "Outline Size", "cl_player_outline_size", "graphics", {
      min: 0,
      max: 100,
      step: 1,
    });
    this.addCvarToggle(playerVisibility.rows, "Fullbright Boost", "cl_player_fullbright", "graphics");
    this.addCvarSlider(playerVisibility.rows, "Boost Amount", "cl_player_fullbright_intensity", "graphics", {
      min: 0,
      max: 1,
      step: 0.05,
      suffix: "%",
    });
    grid.appendChild(playerVisibility.section);
    return panel;
  }

  private buildAudioTab(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "fps-settings-panel";

    const grid = document.createElement("div");
    grid.className = "fps-settings-grid";
    panel.appendChild(grid);

    const music = this.createSection("Music");
    this.addCvarToggle(music.rows, "Enabled", "s_musicenabled", "audio");
    this.addCvarSlider(music.rows, "Music Volume", "s_volume", "audio", { min: 0, max: 1, step: 0.05, suffix: "%" });
    grid.appendChild(music.section);

    const effects = this.createSection("Effects");
    this.addCvarToggle(effects.rows, "Enabled", "s_sfxenabled", "audio");
    this.addCvarSlider(effects.rows, "Effects Volume", "s_sfxvolume", "audio", {
      min: 0,
      max: 1,
      step: 0.05,
      suffix: "%",
    });
    grid.appendChild(effects.section);

    return panel;
  }

  private buildControlsTab(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "fps-settings-panel";

    const shell = document.createElement("div");
    shell.className = "fps-settings-controls-shell";
    panel.appendChild(shell);

    const subtabBar = document.createElement("div");
    subtabBar.className = "fps-settings-subtabs";
    shell.appendChild(subtabBar);

    const content = document.createElement("div");
    shell.appendChild(content);

    const kbmBtn = this.createSubtabButton(subtabBar, "keyboard-mouse", "Keyboard and Mouse", false);
    const controllerBtn = this.createSubtabButton(subtabBar, "controller", "Controller", true);
    this.controlsSubtabButtons.set("keyboard-mouse", kbmBtn);
    this.controlsSubtabButtons.set("controller", controllerBtn);

    const kbmPanel = this.buildKeyboardMousePanel();
    const controllerPanel = this.buildControllerPanel();
    content.appendChild(kbmPanel);
    content.appendChild(controllerPanel);
    this.controlsSubtabPanels.set("keyboard-mouse", kbmPanel);
    this.controlsSubtabPanels.set("controller", controllerPanel);
    this.switchControlsSubtab("keyboard-mouse");

    return panel;
  }

  private buildInterfaceTab(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "fps-settings-panel";

    const grid = document.createElement("div");
    grid.className = "fps-settings-grid";
    panel.appendChild(grid);

    const crosshair = this.createSection("Crosshair");
    this.addCvarToggle(crosshair.rows, "Enabled", "cg_crosshair", "interface");
    this.addCvarSlider(crosshair.rows, "Size", "cg_crosshairSize", "interface", { min: 8, max: 64, step: 1 });
    this.addCvarSlider(crosshair.rows, "Opacity", "cg_crosshairAlpha", "interface", {
      min: 0.1,
      max: 1,
      step: 0.05,
      suffix: "%",
    });
    this.addColorRow(crosshair.rows, "Color", "cg_crosshairColor", "interface");
    this.addCvarToggle(crosshair.rows, "Dynamic Spread", "cg_crosshairSpread", "interface");
    this.addColorRow(crosshair.rows, "Hit Color", "cg_crosshairDmgColor", "interface");
    grid.appendChild(crosshair.section);


    const network = this.createSection("Network");
    this.addSelectRow(
      network.rows,
      "NetGraph",
      [
        { label: "Off", value: 0 },
        { label: "Text", value: 1 },
        { label: "Graph", value: 2 },
      ],
      "interface",
      () => Cvar.getNumber("cl_netgraph"),
      (value) => {
        Cvar.set("cl_netgraph", value);
      },
      () => {
        Cvar.reset("cl_netgraph");
      },
    );
    grid.appendChild(network.section);

    return panel;
  }

  private buildKeyboardMousePanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "fps-settings-panel";

    for (const action of ACTION_DEFINITIONS) {
      this.addReset("controls", () => this.input.resetBinding(action.id));
    }

    const layout = document.createElement("div");
    layout.className = "fps-settings-controls-layout";
    panel.appendChild(layout);

    const mouseCard = document.createElement("div");
    mouseCard.className = "fps-settings-card fps-settings-card--mouse";
    layout.appendChild(mouseCard);

    const mouseTitle = document.createElement("div");
    mouseTitle.className = "fps-settings-card-title";
    mouseTitle.textContent = "Mouse";
    mouseCard.appendChild(mouseTitle);

    const mouseLayout = document.createElement("div");
    mouseLayout.className = "fps-settings-mouse-layout";
    mouseCard.appendChild(mouseLayout);

    const mouseVisual = document.createElement("div");
    mouseVisual.className = "fps-settings-mouse-visual";
    mouseLayout.appendChild(mouseVisual);

    const mouseShell = document.createElement("div");
    mouseShell.className = "fps-settings-mouse-shell";
    mouseVisual.appendChild(mouseShell);

    const divider = document.createElement("div");
    divider.className = "fps-settings-mouse-divider";
    mouseVisual.appendChild(divider);

    const wheel = document.createElement("div");
    wheel.className = "fps-settings-mouse-wheel";
    mouseVisual.appendChild(wheel);

    for (const slot of MOUSE_SLOTS) {
      const hotspot = document.createElement("button");
      hotspot.type = "button";
      hotspot.dataset.slot = slot.id;
      hotspot.dataset.settingsSlot = slot.id;
      hotspot.className = "fps-settings-mouse-hotspot";
      hotspot.title = slot.display;
      hotspot.addEventListener("click", (event) => {
        event.preventDefault();
        this.openContextMenu(slot.id, hotspot);
      });
      mouseVisual.appendChild(hotspot);
      this.mouseHotspots.set(slot.id, hotspot);

      const callout = document.createElement("div");
      callout.className = `fps-settings-mouse-callout fps-settings-mouse-callout--${slot.id}`;
      mouseVisual.appendChild(callout);

      const card = document.createElement("button");
      card.type = "button";
      card.className = "fps-settings-mouse-callout-card";
      card.dataset.settingsSlot = slot.id;
      card.addEventListener("click", (event) => {
        event.preventDefault();
        this.openContextMenu(slot.id, card);
      });
      callout.appendChild(card);

      const slotLabel = document.createElement("span");
      slotLabel.className = "fps-settings-mouse-callout-slot";
      slotLabel.textContent = slot.display;
      card.appendChild(slotLabel);

      const actionLabel = document.createElement("span");
      actionLabel.className = "fps-settings-mouse-callout-action";
      actionLabel.textContent = "Unbound";
      card.appendChild(actionLabel);

      this.mouseCards.set(slot.id, card);
    }

    const mouseSettings = document.createElement("div");
    mouseSettings.className = "fps-settings-mouse-settings";
    mouseLayout.appendChild(mouseSettings);
    this.addCvarSlider(mouseSettings, "Sensitivity", "m_sensitivity", "controls", { min: 0.1, max: 10, step: 0.1 });
    this.addCvarSlider(mouseSettings, "ADS Sensitivity", "cl_ads_sensitivity", "controls", {
      min: 0.1,
      max: 1,
      step: 0.05,
      suffix: "%",
    });
    this.addCvarToggle(mouseSettings, "Always Run", "cl_autorun", "controls");

    const inlineControls = document.createElement("div");
    inlineControls.className = "fps-settings-inline-controls";
    mouseSettings.appendChild(inlineControls);

    const testBtn = document.createElement("button");
    testBtn.className = "fps-btn fps-settings-placeholder-btn";
    testBtn.disabled = true;
    testBtn.textContent = "Test Sensitivity";
    inlineControls.appendChild(testBtn);

    const testCaption = document.createElement("div");
    testCaption.className = "fps-settings-placeholder-caption";
    testCaption.textContent = "Reserved for a follow-up tuning sandbox.";
    mouseSettings.appendChild(testCaption);

    const keyboardCard = document.createElement("div");
    keyboardCard.className = "fps-settings-card fps-settings-card--keyboard";
    layout.appendChild(keyboardCard);

    const keyboardTitle = document.createElement("div");
    keyboardTitle.className = "fps-settings-card-title";
    keyboardTitle.textContent = "Keyboard";
    keyboardCard.appendChild(keyboardTitle);

    const keyboardNote = document.createElement("div");
    keyboardNote.className = "fps-settings-card-note";
    keyboardNote.textContent = "Click any key to assign what it does. Bound gameplay keys glow brighter for quick scanning.";
    keyboardCard.appendChild(keyboardNote);

    const keyboardWrap = document.createElement("div");
    keyboardWrap.className = "fps-settings-keyboard-wrap";
    keyboardCard.appendChild(keyboardWrap);

    const keyboardBoard = document.createElement("div");
    keyboardBoard.className = "fps-settings-keyboard-board";
    keyboardWrap.appendChild(keyboardBoard);

    for (const row of KEYBOARD_ROWS) {
      const rowEl = document.createElement("div");
      rowEl.className = "fps-settings-keyboard-row";
      keyboardBoard.appendChild(rowEl);

      for (const slot of row) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "fps-settings-key fps-settings-key--empty";
        button.style.setProperty("--key-width", String(slot.width ?? 1));
        button.dataset.settingsSlot = slot.id;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          this.openContextMenu(slot.id, button);
        });

        const cap = document.createElement("span");
        cap.className = "fps-settings-keycap";
        cap.textContent = slot.display;
        button.appendChild(cap);

        const action = document.createElement("span");
        action.className = "fps-settings-key-action";
        action.textContent = " ";
        button.appendChild(action);

        rowEl.appendChild(button);
        this.keyButtons.set(slot.id, button);
      }
    }

    return panel;
  }

  private buildControllerPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "fps-settings-panel";

    const card = document.createElement("div");
    card.className = "fps-settings-card fps-settings-controller-placeholder";
    panel.appendChild(card);

    const title = document.createElement("div");
    title.className = "fps-settings-card-title";
    title.textContent = "Controller";
    card.appendChild(title);

    const icon = document.createElement("div");
    icon.className = "fps-settings-controller-icon";
    card.appendChild(icon);

    const tag = document.createElement("div");
    tag.className = "fps-settings-controller-tag";
    tag.textContent = "Coming Later";
    card.appendChild(tag);

    const note = document.createElement("div");
    note.className = "fps-settings-card-note";
    note.textContent =
      "The tab stays visible so the controls layout feels complete, but controller support is intentionally disabled in this first pass.";
    card.appendChild(note);

    return panel;
  }

  private createSubtabButton(
    container: HTMLElement,
    id: ControlsSubtabId,
    label: string,
    disabled: boolean,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fps-settings-subtab-btn";
    button.textContent = label;
    button.disabled = disabled;
    if (!disabled) {
      button.addEventListener("click", () => this.switchControlsSubtab(id));
    }
    container.appendChild(button);
    return button;
  }

  private switchControlsSubtab(id: ControlsSubtabId): void {
    for (const [subtabId, button] of this.controlsSubtabButtons) {
      button.className = buttonClass("fps-settings-subtab-btn", subtabId === id);
      if (button.disabled) {
        button.classList.remove("fps-settings-subtab-btn--active");
      }
    }
    for (const [subtabId, panel] of this.controlsSubtabPanels) {
      panel.classList.toggle("fps-settings-panel--active", subtabId === id);
    }
  }

  private createSection(title: string): { section: HTMLElement; rows: HTMLElement } {
    const section = document.createElement("div");
    section.className = "fps-settings-section";

    const titleEl = document.createElement("div");
    titleEl.className = "fps-settings-section-title";
    titleEl.textContent = title;
    section.appendChild(titleEl);

    const rows = document.createElement("div");
    section.appendChild(rows);
    return { section, rows };
  }

  private addRefresh(callback: RefreshCallback): void {
    this.refreshCallbacks.push(callback);
  }

  private addReset(tabId: SettingsTabId, callback: ResetCallback): void {
    if (!this.tabResets.has(tabId)) {
      this.tabResets.set(tabId, []);
    }
    this.tabResets.get(tabId)!.push(callback);
  }

  private addFullscreenToggle(container: HTMLElement, tabId: SettingsTabId): void {
    const row = this.createToggleRow("Fullscreen", async () => await getFullscreenState(), async (value) => {
      await setFullscreenState(value);
      await this.refresh();
    });
    container.appendChild(row.row);
    this.addRefresh(row.refresh);
    this.addReset(tabId, async () => {
      await setFullscreenState(false);
    });
  }

  private addBloomToggle(container: HTMLElement, tabId: SettingsTabId): void {
    const row = this.createSliderRow("Bloom", { min: 0, max: 3, step: 0.1 }, () => Cvar.getNumber("r_bloom"), (value) => {
      Cvar.set("r_bloom", value);
    });
    container.appendChild(row.row);
    this.addRefresh(row.refresh);
    this.addReset(tabId, () => {
      Cvar.reset("r_bloom");
    });
  }

  private addCvarToggle(container: HTMLElement, label: string, cvarName: string, tabId: SettingsTabId): void {
    const row = this.createToggleRow(label, () => Cvar.getBool(cvarName), (value) => {
      Cvar.set(cvarName, value ? 1 : 0);
    });
    container.appendChild(row.row);
    this.addRefresh(row.refresh);
    this.addReset(tabId, () => {
      Cvar.reset(cvarName);
    });
  }

  private addCvarSlider(
    container: HTMLElement,
    label: string,
    cvarName: string,
    tabId: SettingsTabId,
    options: { min: number; max: number; step: number; suffix?: string },
  ): void {
    const row = this.createSliderRow(label, options, () => Cvar.getNumber(cvarName), (value) => {
      Cvar.set(cvarName, value);
    });
    container.appendChild(row.row);
    this.addRefresh(row.refresh);
    this.addReset(tabId, () => {
      Cvar.reset(cvarName);
    });
  }

  private addSelectRow(
    container: HTMLElement,
    label: string,
    options: Array<{ label: string; value: number }>,
    tabId: SettingsTabId,
    getter: () => number,
    setter: (value: number) => void,
    reset: ResetCallback,
  ): void {
    const row = document.createElement("div");
    row.className = "fps-settings-row";

    const labelEl = document.createElement("span");
    labelEl.className = "fps-settings-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const control = document.createElement("div");
    control.className = "fps-settings-control";
    row.appendChild(control);

    const select = document.createElement("select");
    select.className = "fps-settings-select";
    for (const option of options) {
      const optionEl = document.createElement("option");
      optionEl.value = String(option.value);
      optionEl.textContent = option.label;
      select.appendChild(optionEl);
    }

    select.addEventListener("change", () => {
      setter(Number(select.value));
      void this.refresh();
    });

    control.appendChild(select);
    this.addRefresh(() => {
      select.value = String(getter());
    });
    this.addReset(tabId, reset);
    container.appendChild(row);
  }

  private addColorRow(container: HTMLElement, label: string, cvarName: string, tabId: SettingsTabId): void {
    const row = document.createElement("div");
    row.className = "fps-settings-row";

    const labelEl = document.createElement("span");
    labelEl.className = "fps-settings-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const control = document.createElement("div");
    control.className = "fps-settings-control";
    row.appendChild(control);

    const selectControl = document.createElement("div");
    selectControl.className = "fps-settings-color-select";
    control.appendChild(selectControl);

    const preview = document.createElement("span");
    preview.className = "fps-settings-color-preview";
    selectControl.appendChild(preview);

    const select = document.createElement("select");
    select.className = "fps-settings-select";
    selectControl.appendChild(select);

    for (const preset of COLOR_PRESETS) {
      const option = document.createElement("option");
      option.value = preset.value;
      option.textContent = preset.label;
      select.appendChild(option);
    }

    select.addEventListener("change", () => {
      Cvar.set(cvarName, select.value);
      void this.refresh();
    });

    this.addRefresh(() => {
      const current = Cvar.getString(cvarName).toUpperCase();
      select.value = current;
      preview.style.background = `#${current}`;
    });
    this.addReset(tabId, () => {
      Cvar.reset(cvarName);
    });
    container.appendChild(row);
  }


  private addRgbColorPickerRow(container: HTMLElement, label: string, cvarName: string, tabId: SettingsTabId): void {
    const row = document.createElement("div");
    row.className = "fps-settings-row";

    const labelEl = document.createElement("span");
    labelEl.className = "fps-settings-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const control = document.createElement("div");
    control.className = "fps-settings-control";
    row.appendChild(control);

    const pickerControl = document.createElement("div");
    pickerControl.className = "fps-settings-color-select";
    control.appendChild(pickerControl);

    const input = document.createElement("input");
    input.className = "fps-settings-color-input";
    input.type = "color";
    pickerControl.appendChild(input);

    const valueEl = document.createElement("span");
    valueEl.className = "fps-settings-color-value";
    pickerControl.appendChild(valueEl);

    input.addEventListener("input", () => {
      Cvar.set(cvarName, hexToRgbCvar(input.value));
      void this.refresh();
    });

    this.addRefresh(() => {
      const current = Cvar.getString(cvarName);
      input.value = rgbCvarToHexValue(current);
      valueEl.textContent = current.trim();
    });
    this.addReset(tabId, () => {
      Cvar.reset(cvarName);
    });
    container.appendChild(row);
  }

  private createSliderRow(
    label: string,
    options: { min: number; max: number; step: number; suffix?: string },
    getter: () => number,
    setter: (value: number) => void,
  ): { row: HTMLElement; refresh: RefreshCallback } {
    const row = document.createElement("div");
    row.className = "fps-settings-row";

    const labelEl = document.createElement("span");
    labelEl.className = "fps-settings-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const control = document.createElement("div");
    control.className = "fps-settings-control";
    row.appendChild(control);

    const slider = document.createElement("input");
    slider.className = "fps-settings-slider";
    slider.type = "range";
    slider.min = String(options.min);
    slider.max = String(options.max);
    slider.step = String(options.step);
    control.appendChild(slider);

    const valueEl = document.createElement("span");
    valueEl.className = "fps-settings-value";
    control.appendChild(valueEl);

    const updateTrack = (value: number) => {
      const pct = ((value - options.min) / (options.max - options.min)) * 100;
      slider.style.background = `linear-gradient(90deg, hsla(180, 100%, 50%, 0.42) 0%, hsla(180, 100%, 50%, 0.22) ${pct}%, hsla(180, 40%, 30%, 0.2) ${pct}%)`;
    };

    slider.addEventListener("input", () => {
      const numeric = Number(slider.value);
      setter(numeric);
      valueEl.textContent = this.formatSliderValue(numeric, options.suffix);
      updateTrack(numeric);
    });

    const refresh = () => {
      const value = getter();
      slider.value = String(value);
      valueEl.textContent = this.formatSliderValue(value, options.suffix);
      updateTrack(value);
    };

    return { row, refresh };
  }

  private formatSliderValue(value: number, suffix?: string): string {
    if (suffix === "%") {
      return `${Math.round(value * 100)}%`;
    }

    const rounded = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
    return suffix ? `${rounded}${suffix}` : rounded;
  }

  private openResetDialog(title: string, message: string, confirmText: string, onConfirm: () => void): void {
    this.resetDialog?.destroy();

    const dialog = new SettingsConfirmDialog(title, "fps-settings-confirm");
    this.resetDialog = dialog;

    const copy = document.createElement("div");
    copy.className = "fps-settings-confirm-copy";
    copy.textContent = message;
    dialog.body.appendChild(copy);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "fps-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      dialog.close();
    });

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "fps-btn fps-btn--primary";
    confirmBtn.textContent = confirmText;
    confirmBtn.addEventListener("click", () => {
      dialog.close();
      onConfirm();
    });

    dialog.footer.appendChild(cancelBtn);
    dialog.footer.appendChild(confirmBtn);
    dialog.onClose(() => {
      if (this.resetDialog === dialog) {
        this.resetDialog = null;
      }
      dialog.destroy();
    });
    dialog.open();
  }

  private createToggleRow(
    label: string,
    getter: () => boolean | Promise<boolean>,
    setter: (value: boolean) => void | Promise<void>,
  ): { row: HTMLElement; refresh: RefreshCallback } {
    const row = document.createElement("div");
    row.className = "fps-settings-row";

    const labelEl = document.createElement("span");
    labelEl.className = "fps-settings-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const control = document.createElement("div");
    control.className = "fps-settings-control";
    row.appendChild(control);

    const stateLabel = document.createElement("span");
    stateLabel.className = "fps-settings-toggle-label";
    control.appendChild(stateLabel);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "fps-settings-toggle";
    control.appendChild(toggle);

    toggle.addEventListener("click", async () => {
      const enabled = toggle.classList.contains("fps-settings-toggle--on");
      await setter(!enabled);
      await refresh();
    });

    const refresh = async () => {
      const enabled = await getter();
      toggle.classList.toggle("fps-settings-toggle--on", enabled);
      stateLabel.textContent = enabled ? "On" : "Off";
    };

    return { row, refresh };
  }

  private getCurrentBindings(actionId: string): InputBinding[] {
    const action = ACTION_LOOKUP.get(actionId);
    if (!action) return [];

    const overrides = this.input.exportBindings();
    const current = overrides[actionId] ?? action.defaults;
    return normalizeBindings(current);
  }

  private applyActionBindings(actionId: string, nextBindings: InputBinding[]): void {
    const action = ACTION_LOOKUP.get(actionId);
    if (!action) return;

    const normalized = normalizeBindings(nextBindings);
    if (bindingsEqual(normalized, normalizeBindings(action.defaults))) {
      this.input.resetBinding(actionId);
      return;
    }

    this.input.rebind(actionId, normalized);
  }

  private getActionForSlot(slotId: string): ActionDefinition | null {
    const slot = this.getSlot(slotId);
    if (!slot) return null;

    for (const action of ACTION_DEFINITIONS) {
      const bindings = this.getCurrentBindings(action.id);
      if (bindings.some((binding) => slotMatchesBinding(slot, binding))) {
        return action;
      }
    }

    return null;
  }

  private getSlot(slotId: string): SlotDefinition | null {
    for (const row of KEYBOARD_ROWS) {
      const slot = row.find((key) => key.id === slotId);
      if (slot) return slot;
    }

    return MOUSE_SLOTS.find((slot) => slot.id === slotId) ?? null;
  }

  private refreshSlotVisuals(): void {
    for (const row of KEYBOARD_ROWS) {
      for (const slot of row) {
        const action = this.getActionForSlot(slot.id);
        const button = this.keyButtons.get(slot.id);
        if (!button) continue;
        const actionEl = button.querySelector(".fps-settings-key-action") as HTMLElement | null;
        if (actionEl) {
          actionEl.textContent = action?.keyTag ?? "";
        }
        button.title = action ? `${slot.display}: ${action.label}` : `${slot.display}: Unbound`;
        button.className = "fps-settings-key";
        if (action) {
          button.classList.add("fps-settings-key--bound");
        } else {
          button.classList.add("fps-settings-key--empty");
        }
        if (this.selectedSlotId === slot.id) {
          button.classList.add("fps-settings-key--selected");
        }
      }
    }

    for (const slot of MOUSE_SLOTS) {
      const action = this.getActionForSlot(slot.id);
      const hotspot = this.mouseHotspots.get(slot.id);
      const card = this.mouseCards.get(slot.id);
      const label = card?.querySelector(".fps-settings-mouse-callout-action") as HTMLElement | null;

      if (label) {
        label.textContent = action?.label ?? "Unbound";
      }

      if (hotspot) {
        hotspot.title = action ? `${slot.display}: ${action.label}` : `${slot.display}: Unbound`;
        hotspot.className = "fps-settings-mouse-hotspot";
        if (action) hotspot.classList.add("fps-settings-mouse-hotspot--bound");
        if (this.selectedSlotId === slot.id) hotspot.classList.add("fps-settings-mouse-hotspot--selected");
      }

      if (card) {
        card.title = action ? `${slot.display}: ${action.label}` : `${slot.display}: Unbound`;
        card.className = "fps-settings-mouse-callout-card";
        if (this.selectedSlotId === slot.id) {
          card.classList.add("fps-settings-mouse-callout-card--selected");
        }
      }
    }
  }

  private openContextMenu(slotId: string, anchor: HTMLElement): void {
    this.selectedSlotId = slotId;
    this.contextMenuCategory = "movement";
    this.renderContextMenu(anchor);
    this.refreshSlotVisuals();
  }

  private renderContextMenu(anchor: HTMLElement): void {
    this.closeContextMenu(false);

    const slot = this.getSlot(this.selectedSlotId ?? "");
    if (!slot) return;

    const menu = document.createElement("div");
    menu.className = "fps-settings-menu";

    const categoryColumn = document.createElement("div");
    categoryColumn.className = "fps-settings-menu-column";
    menu.appendChild(categoryColumn);

    const categoryHeader = document.createElement("div");
    categoryHeader.className = "fps-settings-menu-header";
    categoryHeader.textContent = slot.display;
    categoryColumn.appendChild(categoryHeader);

    const actionColumn = document.createElement("div");
    actionColumn.className = "fps-settings-menu-column";
    menu.appendChild(actionColumn);

    const actionHeader = document.createElement("div");
    actionHeader.className = "fps-settings-menu-header";
    actionColumn.appendChild(actionHeader);

    const actionList = document.createElement("div");
    actionColumn.appendChild(actionList);

    const renderActions = () => {
      const category = ACTION_CATEGORIES.find((item) => item.id === this.contextMenuCategory);
      actionHeader.textContent = category?.label ?? "Actions";
      actionList.innerHTML = "";

      const actions = ACTION_DEFINITIONS.filter((action) => action.category === this.contextMenuCategory);
      for (const action of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "fps-settings-menu-btn";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          this.assignSlot(slot.id, action.id);
        });
        actionList.appendChild(button);
      }

      const occupied = this.getActionForSlot(slot.id);
      if (occupied) {
        const unbind = document.createElement("button");
        unbind.type = "button";
        unbind.className = "fps-settings-menu-btn fps-settings-menu-btn--danger";
        unbind.textContent = "Unbind";
        unbind.addEventListener("click", () => {
          this.assignSlot(slot.id, null);
        });
        actionList.appendChild(unbind);
      }
    };

    for (const category of ACTION_CATEGORIES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = buttonClass("fps-settings-menu-btn", category.id === this.contextMenuCategory);
      button.innerHTML = `<span>${category.label}</span><span class="fps-settings-menu-arrow">›</span>`;
      button.addEventListener("mouseenter", () => {
        this.contextMenuCategory = category.id;
        for (const categoryButton of categoryColumn.querySelectorAll<HTMLButtonElement>(".fps-settings-menu-btn")) {
          categoryButton.className = buttonClass(
            "fps-settings-menu-btn",
            categoryButton.dataset.category === this.contextMenuCategory,
          );
        }
        renderActions();
      });
      button.addEventListener("click", () => {
        this.contextMenuCategory = category.id;
        for (const categoryButton of categoryColumn.querySelectorAll<HTMLButtonElement>(".fps-settings-menu-btn")) {
          categoryButton.className = buttonClass(
            "fps-settings-menu-btn",
            categoryButton.dataset.category === this.contextMenuCategory,
          );
        }
        renderActions();
      });
      button.dataset.category = category.id;
      categoryColumn.appendChild(button);
    }

    renderActions();
    this.root.appendChild(menu);
    this.contextMenu = menu;

    const rect = anchor.getBoundingClientRect();
    const menuWidth = 400;
    const menuHeight = 320;
    const left = Math.min(window.innerWidth - menuWidth - 16, Math.max(16, rect.left + rect.width + 12));
    const top = Math.min(window.innerHeight - menuHeight - 16, Math.max(16, rect.top - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private closeContextMenu(clearSelection: boolean = true): void {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
    if (clearSelection) {
      this.selectedSlotId = null;
      this.refreshSlotVisuals();
    }
  }

  private assignSlot(slotId: string, actionId: string | null): void {
    const slot = this.getSlot(slotId);
    if (!slot) return;

    for (const action of ACTION_DEFINITIONS) {
      const filtered = this.getCurrentBindings(action.id).filter((binding) => !slotMatchesBinding(slot, binding));
      const next = action.id === actionId ? [...filtered, { ...slot.binding }] : filtered;
      this.applyActionBindings(action.id, next);
    }

    this.closeContextMenu();
    void this.refresh();
  }
}
