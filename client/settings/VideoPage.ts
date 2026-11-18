/**
 * Video: four presets for what costs frames, then the settings themselves in
 * five sections, closed until asked for and one open at a time. Every setting is
 * one of the renderer's own variables; the pips are estimates of what each pass
 * costs.
 *
 * In a match the page is locked: changing the renderer's passes mid-match can
 * leave the view without the game drawn, so video settings change in the lobby.
 */

import { Cvar } from "../../../../engine/core/Cvar";
import { requestBrowserFullscreen } from "../../../../engine/ui/BrowserControlFeedback";
import { createRaisedKey } from "../../../../engine/ui/components/RaisedKey";
import { button, costPips, dropdown, el, type FieldHost, formatPercent, seg, slider } from "./SettingsFields";
import {
  applyChoice,
  COLOR_BLIND_SIDE_COLORS,
  currentChoice,
  GODRAY_CHOICES,
  godrayChoice,
  loadLevel,
  resetSideColors,
  setSideColor,
  sideColorsAreDefault,
  VIDEO_PRESETS,
  VIDEO_SECTIONS,
} from "./SettingsModel";

type SectionId = (typeof VIDEO_SECTIONS)[number]["id"];

async function fullscreenState(): Promise<boolean> {
  if (window.electronAPI?.window?.isFullscreen) {
    try {
      return await window.electronAPI.window.isFullscreen();
    } catch {
      return false;
    }
  }
  return !!document.fullscreenElement;
}

const onOff = [
  { value: 0, label: "Off" },
  { value: 1, label: "On" },
];
const flag = (name: string) => (Cvar.getNumber(name) > 0 ? 1 : 0);

export class VideoPage {
  readonly root: HTMLElement;
  private openSection: SectionId | null = null;
  private readonly sectionKeys = new Map<SectionId, HTMLButtonElement>();
  private readonly sectionFields = new Map<SectionId, HTMLElement>();
  private readonly panel: HTMLElement;
  private fullscreen = false;
  private readonly onFullscreenChange = () => void this.readFullscreen();

  constructor(
    private readonly host: FieldHost & { toast(message: string): void },
    locked = false,
  ) {
    this.root = el("div", "fps-set-video");

    const presets = el("div", "fps-set-presets");
    for (const preset of VIDEO_PRESETS) {
      const meter = el("span", "fps-set-preset__meter");
      for (let i = 0; i < 3; i++) meter.append(el("i", i < preset.bars ? "on" : ""));
      const key = createRaisedKey({
        variants: ["preset"],
        content: [el("span", "fps-set-preset__name", preset.label), meter],
      });
      key.addEventListener("click", () => {
        applyChoice(preset);
        host.changed();
      });
      host.addRefresh(() => key.setAttribute("aria-pressed", String(currentChoice(VIDEO_PRESETS) === preset)));
      presets.append(key);
    }

    const bar = el("div", "fps-set-video-bar");
    const status = el("div", "fps-set-preset-status");
    status.setAttribute("aria-live", "polite");
    bar.append(status);
    host.addRefresh(() => {
      const now = currentChoice(VIDEO_PRESETS);
      status.replaceChildren("Using ", el("b", "", now ? now.label : "your own mix"));
      if (!now) status.append(" · pick a preset to start over from it");
    });

    const sections = el("div", "fps-set-sections");
    this.panel = el("section", "fps-set-card fps-set-section-panel");
    this.panel.id = "fps-set-section-panel";
    for (const section of VIDEO_SECTIONS) {
      const load = el("span", "fps-set-sect__load");
      const key = createRaisedKey({
        variants: ["sect"],
        content: [this.sectionTop(section.name), load],
      });
      key.setAttribute("aria-expanded", "false");
      key.setAttribute("aria-controls", this.panel.id);
      key.addEventListener("click", () => this.showSection(this.openSection === section.id ? null : section.id));
      host.addRefresh(() => {
        const level = loadLevel(section.load());
        load.replaceChildren(costPips(level));
      });
      sections.append(key);
      this.sectionKeys.set(section.id, key);
      const fields = el("div", "fps-set-panel-fields");
      this.sectionFields.set(section.id, fields);
      this.panel.append(fields);
    }

    this.buildScreen(this.sectionFields.get("screen")!);
    this.buildEffects(this.sectionFields.get("effects")!);
    this.buildWorld(this.sectionFields.get("world")!);
    this.buildTextures(this.sectionFields.get("textures")!);
    this.buildAdvanced(this.sectionFields.get("advanced")!);
    this.buildColorCorrection(this.sectionFields.get("advanced")!);

    if (locked) {
      const notice = el("div", "fps-set-locked");
      notice.setAttribute("role", "note");
      notice.append(
        el("b", "", "Video settings change in the lobby."),
        " Leave the match to adjust them; fullscreen still works with Alt+Enter.",
      );
      const content = el("div", "fps-set-video__locked");
      content.inert = true;
      content.setAttribute("aria-disabled", "true");
      content.append(presets, bar, sections, this.panel);
      this.root.append(notice, content);
    } else {
      this.root.append(presets, bar, sections, this.panel);
    }
    this.showSection(null);
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    void this.readFullscreen();
  }

  /** Esc closes an open section before it does anything else. */
  closeSection(): boolean {
    if (!this.openSection) return false;
    this.showSection(null);
    return true;
  }

  destroy(): void {
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
  }

  private sectionTop(name: string): HTMLElement {
    const top = el("span", "fps-set-sect__top");
    top.append(el("span", "fps-set-sect__name", name), el("span", "fps-set-sect__chev", "▾"));
    return top;
  }

  private showSection(id: SectionId | null): void {
    this.openSection = id;
    for (const [sectionId, key] of this.sectionKeys) {
      key.setAttribute("aria-expanded", String(sectionId === id));
      key.classList.toggle("is-open", sectionId === id);
    }
    this.panel.hidden = id === null;
    for (const [sectionId, fields] of this.sectionFields) fields.hidden = sectionId !== id;
  }

  private async readFullscreen(): Promise<void> {
    this.fullscreen = await fullscreenState();
    this.host.changed();
  }

  private buildScreen(parent: HTMLElement): void {
    seg(this.host, parent, {
      name: "Fullscreen",
      choices: onOff,
      get: () => (this.fullscreen ? 1 : 0),
      set: async (value) => {
        await requestBrowserFullscreen(value === 1, (message) => this.host.toast(message));
        await this.readFullscreen();
      },
    });
    for (const [name, label] of [
      ["r_exposure", "Brightness"],
      ["r_contrast", "Contrast"],
    ]) {
      slider(this.host, parent, {
        name: label,
        min: 0.5,
        max: 2,
        step: 0.05,
        format: formatPercent,
        get: () => Cvar.getNumber(name),
        set: (value) => Cvar.set(name, value),
      });
    }
    slider(this.host, parent, {
      name: "Render resolution",
      cost: "high",
      min: 0.25,
      max: 1,
      step: 0.05,
      format: formatPercent,
      get: () => Cvar.getNumber("r_renderscale"),
      set: (value) => Cvar.set("r_renderscale", value),
    });
    seg(this.host, parent, {
      name: "Antialiasing",
      cost: "mid",
      tag: "Restart",
      choices: onOff,
      get: () => flag("r_msaa"),
      set: (value) => {
        Cvar.set("r_msaa", value);
      },
    });
  }

  private buildEffects(parent: HTMLElement): void {
    slider(this.host, parent, {
      name: "Bloom",
      cost: "low",
      min: 0,
      max: 3,
      step: 0.1,
      get: () => Cvar.getNumber("r_bloom"),
      set: (value) => Cvar.set("r_bloom", value),
    });
    seg(this.host, parent, {
      name: "Reflections",
      cost: "high",
      choices: onOff,
      get: () => flag("r_ssr"),
      set: (value) => {
        Cvar.set("r_ssr", value);
      },
    });
    seg(this.host, parent, {
      name: "Light shafts",
      cost: "mid",
      choices: GODRAY_CHOICES.map((choice) => ({ value: choice, label: choice.label })),
      get: () => godrayChoice(),
      set: (choice) => applyChoice(choice),
    });
    seg(this.host, parent, {
      name: "Soft halos",
      cost: "low",
      choices: onOff,
      get: () => flag("r_softhalos"),
      set: (value) => {
        Cvar.set("r_softhalos", value);
      },
    });
    slider(this.host, parent, {
      name: "Glow",
      cost: "mid",
      min: 0,
      max: 2,
      step: 0.05,
      get: () => Cvar.getNumber("r_glow"),
      set: (value) => Cvar.set("r_glow", value),
    });
    slider(this.host, parent, {
      name: "Reflection strength",
      min: 0,
      max: 2,
      step: 0.05,
      enabledIf: () => flag("r_ssr") === 1,
      get: () => Cvar.getNumber("r_ssr_strength"),
      set: (value) => Cvar.set("r_ssr_strength", value),
    });
    seg(this.host, parent, {
      name: "Comic outlines",
      cost: "low",
      choices: onOff,
      shownIf: () => Cvar.exists("r_cel_outlines"),
      get: () => flag("r_cel_outlines"),
      set: (value) => {
        Cvar.set("r_cel_outlines", value);
      },
    });
    seg(this.host, parent, {
      name: "Dynamic lights",
      cost: "mid",
      tag: "Next map",
      choices: onOff,
      get: () => flag("r_dynamiclight"),
      set: (value) => {
        Cvar.set("r_dynamiclight", value);
      },
    });
    for (const [name, label] of [
      ["r_gibs", "Gibs"],
      ["r_marks", "Wall marks"],
      ["r_teleport_ghost", "Teleport afterimage"],
    ]) {
      seg(this.host, parent, {
        name: label,
        cost: "low",
        choices: onOff,
        get: () => flag(name),
        set: (value) => {
          Cvar.set(name, value);
        },
      });
    }
  }

  private buildWorld(parent: HTMLElement): void {
    seg(this.host, parent, {
      name: "Water",
      cost: "mid",
      choices: [
        { value: 1, label: "Low" },
        { value: 2, label: "Medium" },
        { value: 3, label: "High" },
      ],
      get: () => Cvar.getNumber("r_water_quality"),
      set: (value) => {
        Cvar.set("r_water_quality", value);
      },
    });
    seg(this.host, parent, {
      name: "Players in water",
      cost: "low",
      choices: onOff,
      enabledIf: () => Cvar.getNumber("r_water_quality") >= 3,
      get: () => flag("r_water_actors"),
      set: (value) => {
        Cvar.set("r_water_actors", value);
      },
    });
    seg(this.host, parent, {
      name: "Glowing panel light",
      cost: "mid",
      tag: "Next map",
      choices: onOff,
      get: () => flag("r_arealights"),
      set: (value) => {
        Cvar.set("r_arealights", value);
      },
    });
    seg(this.host, parent, {
      name: "Fog",
      cost: "low",
      choices: onOff,
      get: () => flag("r_fog"),
      set: (value) => {
        Cvar.set("r_fog", value === 1);
      },
    });
    slider(this.host, parent, {
      name: "Underwater wobble",
      min: 0,
      max: 1,
      step: 0.05,
      format: formatPercent,
      get: () => Cvar.getNumber("r_underwater_distortion"),
      set: (value) => Cvar.set("r_underwater_distortion", value),
    });
  }

  private buildAdvanced(parent: HTMLElement): void {
    seg(this.host, parent, {
      name: "Renderer",
      tag: "Restart",
      choices: [
        { value: 1, label: "WebGPU" },
        { value: 0, label: "WebGL2" },
      ],
      get: () => flag("r_renderer"),
      set: (value) => {
        Cvar.set("r_renderer", value);
      },
    });
    seg(this.host, parent, {
      name: "Map texture detail",
      tag: "Next map",
      choices: [
        { value: 0, label: "Full" },
        { value: 1, label: "Soft" },
        { value: 2, label: "Softer" },
        { value: 4, label: "Blurred" },
        { value: 8, label: "Flat color" },
      ],
      get: () => Cvar.getNumber("r_picmip"),
      set: (value) => {
        Cvar.set("r_picmip", value);
      },
    });
  }

  /** Accessibility, not frame cost: these follow the player's account and no preset touches them. */
  private buildColorCorrection(parent: HTMLElement): void {
    dropdown(this.host, parent, {
      name: "Color blindness",
      cost: "low",
      shownIf: () => Cvar.exists("r_colorcorrection"),
      choices: [
        { value: 0, label: "Off" },
        {
          value: 1,
          label: "Red-weak (protanopia)",
        },
        {
          value: 2,
          label: "Green-weak (deuteranopia)",
        },
        {
          value: 3,
          label: "Blue-yellow (tritanopia)",
        },
      ],
      get: () => Cvar.getInt("r_colorcorrection"),
      set: (value) => {
        const turningOn = Cvar.getInt("r_colorcorrection") === 0 && value > 0;
        Cvar.set("r_colorcorrection", value);
        // The default team colours are a pair colour-blind eyes mix up; swap
        // them, but only when the player never picked their own, and say so.
        if (turningOn && sideColorsAreDefault()) {
          setSideColor("ally", COLOR_BLIND_SIDE_COLORS.ally);
          setSideColor("enemy", COLOR_BLIND_SIDE_COLORS.enemy);
          notice.hidden = false;
        } else if (value === 0) notice.hidden = true;
      },
    });
    const notice = el("div", "fps-set-notice");
    notice.setAttribute("role", "status");
    notice.hidden = true;
    const undo = button("fps-set-notice__undo", "Undo");
    undo.addEventListener("click", () => {
      resetSideColors();
      notice.hidden = true;
      this.host.changed();
    });
    notice.append(
      el(
        "span",
        "",
        `Team colors changed to ${COLOR_BLIND_SIDE_COLORS.ally.label} for your side and ${COLOR_BLIND_SIDE_COLORS.enemy.label} for enemies, which stay easier to tell apart. Change them under Gameplay, Who's who.`,
      ),
      undo,
    );
    parent.append(notice);
    slider(this.host, parent, {
      name: "Correction strength",
      min: 0,
      max: 1,
      step: 0.05,
      format: formatPercent,
      shownIf: () => Cvar.exists("r_colorcorrection"),
      enabledIf: () => Cvar.getInt("r_colorcorrection") > 0,
      get: () => Cvar.getNumber("r_colorcorrection_strength"),
      set: (value) => Cvar.set("r_colorcorrection_strength", value),
    });
  }

  private buildTextures(parent: HTMLElement): void {
    seg(this.host, parent, {
      name: "Sharpness",
      cost: "low",
      choices: [1, 2, 4, 8, 16].map((value) => ({ value, label: `${value}×` })),
      get: () => Cvar.getNumber("r_anisotropy"),
      set: (value) => {
        Cvar.set("r_anisotropy", value);
      },
    });
    seg(this.host, parent, {
      name: "Detailed surfaces",
      cost: "mid",
      tag: "Next map",
      choices: onOff,
      get: () => flag("r_bsp_pbr"),
      set: (value) => {
        Cvar.set("r_bsp_pbr", value);
      },
    });
  }
}
