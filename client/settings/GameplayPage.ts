/**
 * Gameplay: who is drawn in which colour, the crosshair, and the view. Each has
 * a preview over a slice of a real map, so colours are judged against the game.
 */

import { background } from "../../../../engine/core/AsyncErrors";
import { Cvar } from "../../../../engine/core/Cvar";
import {
  PLAYER_MODEL_LABELS,
  PLAYER_MODEL_PREVIEW_IMAGES,
  PLAYER_MODELS,
  playerModelChoice,
  setPlayerModelChoice,
} from "../PlayerModelSelection";
import type { PlayerTeamPreview } from "./PlayerTeamPreview";
import { card, el, type FieldHost, formatPercent, seg, selectMenu, slider, swatches } from "./SettingsFields";
import {
  applyChoice,
  BOOST_CHOICES,
  CROSSHAIR_COLORS,
  currentChoice,
  cvarDefault,
  HIT_COLORS,
  OUTLINE_CHOICES,
  setSideColor,
  sideColor,
  TEAM_COLORS,
  type TeamColor,
} from "./SettingsModel";

const SVG = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** A slice of an installed map behind a preview; a gradient when it is not there. */
function scene(map: string): HTMLElement {
  const root = el("div", "fps-set-scene");
  root.style.setProperty("--img", `url("/data/levelshots/${map}.jpg")`);
  root.append(el("span", "fps-set-scene__tag", "Preview"));
  return root;
}

const OUTLINE_WIDTH = { off: 0, thin: 2.2, bold: 4.5 };
const BOOST_BRIGHTNESS = { off: 1, tint: 1, some: 1.18, lots: 1.4 };

export class GameplayPage {
  readonly root: HTMLElement;
  private hitUntil = 0;
  private hitTimer = 0;
  private preview?: PlayerTeamPreview;
  private previewObserver?: IntersectionObserver;
  private previewPending = false;
  private previewFailed = false;
  private previewVisible = false;
  private destroyed = false;

  constructor(private readonly host: FieldHost) {
    this.root = el("div", "fps-set-gameplay");
    this.root.append(this.buildTeams(), this.buildCrosshair(), this.buildView());
  }

  destroy(): void {
    window.clearTimeout(this.hitTimer);
    this.destroyed = true;
    this.previewObserver?.disconnect();
    this.preview?.dispose();
  }

  private buildTeams(): HTMLElement {
    const root = card("Who's who", "Your side, and everyone you can shoot", "fps-set-card--wide");
    const teams = el("div", "fps-set-team-grid");
    const slots: HTMLElement[] = [];
    const colorChoices = TEAM_COLORS.map((color) => ({ value: color, label: color.label, css: color.css }));
    for (const side of ["ally", "enemy"] as const) {
      const name = side === "ally" ? "Your team" : "Enemy team";
      const team = el("section", "fps-set-team-card");
      team.dataset.side = side;
      team.setAttribute("aria-label", name);
      team.append(el("h3", "fps-set-team-title", name));
      const preview = scene("washoi_dm5");
      preview.classList.add("fps-set-team-preview", "fps-set-figure");
      preview.dataset.side = side;
      preview.querySelector(".fps-set-scene__tag")?.remove();
      const image = el("img", "fps-set-player-preview");
      image.width = 240;
      image.height = 320;
      image.loading = "lazy";
      const placeholder = el("span", "fps-set-preview-placeholder");
      preview.append(image, placeholder);
      slots.push(preview);
      team.append(preview);
      const controls = el("div", "fps-set-team-controls");
      const label = el("label", "fps-set-model");
      label.append(el("span", "fps-set-field__name", "Model"));
      const menu = selectMenu(
        PLAYER_MODELS.map((model) => PLAYER_MODEL_LABELS[model]),
        `${name} model`,
        (index) => {
          setPlayerModelChoice(side, PLAYER_MODELS[index]);
          this.host.changed();
        },
      );
      label.append(menu.root);
      controls.append(label);
      swatches<TeamColor>(this.host, controls, {
        name: "Colour",
        help: side === "enemy" ? "Everyone else in free-for-all" : undefined,
        choices: colorChoices,
        get: () => sideColor(side),
        set: (color) => setSideColor(side, color),
        blocked: () => {
          const other = sideColor(side === "ally" ? "enemy" : "ally");
          return other ? { value: other, why: "the other side has it" } : null;
        },
      });
      team.append(controls);
      teams.append(team);
      this.host.addRefresh(() => {
        const model = playerModelChoice(side);
        menu.select(PLAYER_MODELS.indexOf(model));
        const path = PLAYER_MODEL_PREVIEW_IMAGES[model];
        image.hidden = !path;
        placeholder.hidden = !!path;
        placeholder.textContent = PLAYER_MODEL_LABELS[model];
        if (path) {
          if (image.getAttribute("src") !== path) image.src = path;
        } else image.removeAttribute("src");
        image.alt = `${PLAYER_MODEL_LABELS[model]} preview`;
        const color = (sideColor(side) ?? TEAM_COLORS[side === "ally" ? 0 : 1]).css;
        team.style.setProperty("--team-color", color);
        const outline = currentChoice(OUTLINE_CHOICES)?.id ?? "thin";
        const boost = currentChoice(BOOST_CHOICES)?.id ?? "some";
        image.style.filter = `brightness(${BOOST_BRIGHTNESS[boost]})${outline === "off" ? "" : ` drop-shadow(0 0 ${OUTLINE_WIDTH[outline]}px ${color})`}`;
      });
    }
    root.append(teams);
    const fields = el("div", "fps-set-team-options");
    root.append(fields);
    if (typeof IntersectionObserver !== "undefined") {
      const visible = new Set<Element>();
      this.previewObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        this.previewVisible = visible.size > 0;
        if (this.previewVisible && !this.preview && !this.previewPending && !this.previewFailed)
          background(this.loadPreview(teams, slots), "Settings player previews");
        this.preview?.setVisible(this.previewVisible);
      });
      for (const slot of slots) this.previewObserver.observe(slot);
    }
    this.host.addRefresh(() => this.preview?.refresh());
    seg(this.host, fields, {
      name: "Outline",
      choices: OUTLINE_CHOICES.map((choice) => ({ value: choice, label: choice.label })),
      get: () => currentChoice(OUTLINE_CHOICES),
      set: (choice) => applyChoice(choice),
    });
    seg(this.host, fields, {
      name: "Brighter players",
      help: "Makes players stand out in dark corners",
      choices: BOOST_CHOICES.map((choice) => ({ value: choice, label: choice.label })),
      get: () => currentChoice(BOOST_CHOICES),
      set: (choice) => applyChoice(choice),
    });

    return root;
  }

  private async loadPreview(root: HTMLElement, slots: HTMLElement[]): Promise<void> {
    this.previewPending = true;
    try {
      const { PlayerTeamPreview } = await import("./PlayerTeamPreview");
      if (this.destroyed) return;
      const preview = new PlayerTeamPreview(root, slots);
      this.preview = preview;
      await preview.initialize();
      if (this.destroyed) preview.dispose();
      else preview.setVisible(this.previewVisible);
    } catch (error) {
      this.previewFailed = true;
      this.preview?.dispose();
      this.preview = undefined;
      console.warn("[Settings] Player previews unavailable", error);
    } finally {
      this.previewPending = false;
    }
  }

  private buildCrosshair(): HTMLElement {
    const root = card("Crosshair", undefined, "fps-set-card--wide");
    const split = el("div", "fps-set-split fps-set-split--x");
    const preview = scene("washoi_dm2");
    const reticle = svgEl("svg", { class: "fps-set-xhair", width: 96, height: 96, viewBox: "-48 -48 96 96" });
    reticle.setAttribute("aria-hidden", "true");
    preview.append(reticle);
    const fields = el("div", "fps-set-field-grid");
    split.append(preview, fields);
    root.append(split);

    const on = () => Cvar.getNumber("cg_crosshair") > 0;
    const onOff = [
      { value: 0, label: "Off" },
      { value: 1, label: "On" },
    ];
    seg(this.host, fields, {
      name: "Crosshair",
      choices: onOff,
      get: () => (on() ? 1 : 0),
      set: (value) => {
        Cvar.set("cg_crosshair", value);
      },
    });
    seg(this.host, fields, {
      name: "Opens up when moving",
      help: "Tightens again while you aim",
      choices: onOff,
      get: () => (Cvar.getNumber("cg_crosshairSpread") > 0 ? 1 : 0),
      set: (value) => {
        Cvar.set("cg_crosshairSpread", value);
      },
    });
    slider(this.host, fields, {
      name: "Size",
      min: 8,
      max: 64,
      step: 1,
      enabledIf: on,
      get: () => Cvar.getNumber("cg_crosshairSize"),
      set: (value) => Cvar.set("cg_crosshairSize", value),
      initial: () => Number(cvarDefault("cg_crosshairSize")),
    });
    slider(this.host, fields, {
      name: "Opacity",
      min: 0.1,
      max: 1,
      step: 0.05,
      format: formatPercent,
      enabledIf: on,
      get: () => Cvar.getNumber("cg_crosshairAlpha"),
      set: (value) => Cvar.set("cg_crosshairAlpha", value),
      initial: () => Number(cvarDefault("cg_crosshairAlpha")),
    });
    const hex = (name: string) => Cvar.getString(name).trim().toUpperCase();
    swatches(this.host, fields, {
      name: "Colour",
      enabledIf: on,
      choices: CROSSHAIR_COLORS.map((color) => ({ value: color.value, label: color.label, css: `#${color.value}` })),
      get: () => CROSSHAIR_COLORS.find((color) => color.value === hex("cg_crosshairColor"))?.value ?? null,
      set: (value) => Cvar.set("cg_crosshairColor", value),
    });
    const hit = swatches(this.host, fields, {
      name: "When you hit",
      help: "Pick one to see it flash",
      enabledIf: on,
      choices: HIT_COLORS.map((color) => ({ value: color.value, label: color.label, css: `#${color.value}` })),
      get: () => HIT_COLORS.find((color) => color.value === hex("cg_crosshairDmgColor"))?.value ?? null,
      set: (value) => Cvar.set("cg_crosshairDmgColor", value),
    });

    // Four bars round a gap, each on a dark underlay, like the game's reticle, at 1.5×
    const draw = () => {
      reticle.classList.toggle("is-off", !on());
      const scale = Cvar.getNumber("cg_crosshairSize") / 24;
      const zoom = 1.5;
      const gap = 4 * zoom;
      const length = Math.round(6 * scale) * zoom;
      const width = Math.max(1, Math.round(2 * scale)) * zoom;
      const color = `#${Date.now() < this.hitUntil ? hex("cg_crosshairDmgColor") : hex("cg_crosshairColor")}`;
      const bars = [
        [-width / 2, -gap - length, width, length],
        [-width / 2, gap, width, length],
        [-gap - length, -width / 2, length, width],
        [gap, -width / 2, length, width],
      ];
      const rect = ([x, y, w, h]: number[], fill: string, pad: number) =>
        svgEl("rect", { x: x - pad, y: y - pad, width: w + pad * 2, height: h + pad * 2, fill });
      reticle.replaceChildren(
        ...bars.map((bar) => rect(bar, "rgba(0,0,0,0.7)", zoom)),
        ...bars.map((bar) => rect(bar, color, 0)),
      );
      reticle.style.opacity = String(Cvar.getNumber("cg_crosshairAlpha"));
    };
    this.host.addRefresh(draw);
    for (const key of hit.querySelectorAll(".fps-set-sw")) {
      key.addEventListener("click", () => {
        this.hitUntil = Date.now() + 500;
        draw();
        window.clearTimeout(this.hitTimer);
        this.hitTimer = window.setTimeout(draw, 520);
      });
    }
    return root;
  }

  private buildView(): HTMLElement {
    const root = card("View & info", undefined, "fps-set-card--wide");
    const fields = el("div", "fps-set-field-grid");
    root.append(fields);

    const fov = slider(this.host, fields, {
      name: "Field of view",
      help: "How wide you see. Wider shows more, but things look smaller",
      min: 80,
      max: 110,
      step: 1,
      format: (value) => `${value}°`,
      get: () => Cvar.getNumber("cl_fov"),
      set: (value) => Cvar.set("cl_fov", value),
      initial: () => Number(cvarDefault("cl_fov")),
    });
    const wedgeBox = el("div", "fps-set-fov");
    const wedgeSvg = svgEl("svg", { viewBox: "-100 -8 200 100", preserveAspectRatio: "xMidYMax meet" });
    wedgeSvg.setAttribute("aria-hidden", "true");
    const wedge = svgEl("path", { fill: "hsla(46,100%,60%,.16)", stroke: "hsl(46 100% 60%)", "stroke-width": 1.5 });
    wedgeSvg.append(wedge, svgEl("circle", { cx: 0, cy: 84, r: 5, fill: "hsl(45 100% 95%)" }));
    wedgeBox.append(wedgeSvg);
    fov.append(wedgeBox);
    this.host.addRefresh(() => {
      const half = (Cvar.getNumber("cl_fov") / 2) * (Math.PI / 180);
      const radius = 92;
      const x = Math.sin(half) * radius;
      const y = 84 - Math.cos(half) * radius;
      wedge.setAttribute("d", `M0 84 L${-x} ${y} A${radius} ${radius} 0 0 1 ${x} ${y} Z`);
    });

    for (const [cvar, name, help] of [
      [
        "cg_screenshake",
        "Explosion shake",
        "The view shakes when a rocket, grenade, plasma or blade blast goes off near you",
      ],
      ["cg_hitshake", "Shake when hit", "The view shakes when you take damage"],
      ["show_fps", "FPS counter", "Frames per second in the top-right corner"],
      ["cl_showspeed", "Movement speed", "Your speed at the bottom of the screen"],
      [
        "cl_hints",
        "Hints",
        "Tips about movement, weapons and items, above your weapons. Shown in warmup and for the first 2 minutes of a match",
      ],
    ]) {
      seg(this.host, fields, {
        name,
        help,
        choices: [
          { value: 0, label: "Off" },
          { value: 1, label: "On" },
        ],
        get: () => (Cvar.getNumber(cvar) > 0 ? 1 : 0),
        set: (value) => {
          Cvar.set(cvar, value);
        },
      });
    }

    seg(this.host, fields, {
      name: "Match clock",
      help: "Count the match time down to the end, or up from the start",
      choices: [
        { value: 0, label: "Time left" },
        { value: 1, label: "Time played" },
      ],
      get: () => (Cvar.getNumber("cl_invertClock") > 0 ? 1 : 0),
      set: (value) => {
        Cvar.set("cl_invertClock", value);
      },
    });

    seg(this.host, fields, {
      name: "Switch to picked-up weapons",
      help: "Take out a weapon you walk over. Off keeps what you hold, so a blade fight stays a blade fight",
      choices: [
        { value: 0, label: "Off" },
        { value: 1, label: "On" },
      ],
      get: () => (Cvar.getNumber("cl_autoswitch") > 0 ? 1 : 0),
      set: (value) => {
        Cvar.set("cl_autoswitch", value);
      },
    });

    seg(this.host, fields, {
      name: "Connection info",
      help: "Ping and packet loss in a corner of the screen",
      choices: [
        { value: 0, label: "Off" },
        { value: 1, label: "Numbers" },
        { value: 2, label: "Graph" },
      ],
      get: () => Cvar.getNumber("cl_netgraph"),
      set: (value) => {
        Cvar.set("cl_netgraph", value);
      },
    });
    return root;
  }
}
