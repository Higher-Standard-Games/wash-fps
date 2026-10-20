/**
 * Gameplay: who is drawn in which colour, the crosshair, and the view. Each has
 * a preview over a slice of a real map, so colours are judged against the game.
 */

import { Cvar } from "../../../../engine/core/Cvar";
import { PLAYER_VOICE_SETS, type PlayerVoiceSet, playerVoiceSet, setPlayerVoiceSet } from "../FPSPlayerAudio";
import { card, el, type FieldHost, formatPercent, seg, selectMenu, slider, swatches } from "./SettingsFields";
import {
  applyChoice,
  BOOST_CHOICES,
  CROSSHAIR_COLORS,
  currentChoice,
  cvarDefault,
  HIT_COLORS,
  OUTLINE_CHOICES,
  type Side,
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

/** A player's shape for the preview: a head and a body. */
function figure(side: Side, tag: string, far = false): HTMLElement {
  const box = el("div", `fps-set-figure${far ? " fps-set-figure--far" : ""}`);
  box.dataset.side = side;
  const svg = svgEl("svg", { viewBox: "0 0 60 120", "aria-hidden": "true" });
  svg.append(
    svgEl("circle", { cx: 30, cy: 13, r: 10 }),
    svgEl("path", {
      d: "M14 27 Q30 21 46 27 L52 60 L44 62 L41 88 L45 118 L34 118 L30 93 L26 118 L15 118 L19 88 L16 62 L8 60 Z",
    }),
  );
  box.append(svg);
  if (tag) box.append(el("span", "fps-set-figure__tag", tag));
  return box;
}

/** A slice of an installed map behind a preview; a gradient when it is not there. */
function scene(map: string): HTMLElement {
  const root = el("div", "fps-set-scene");
  root.style.setProperty("--img", `url("/data/levelshots/${map}.jpg")`);
  root.append(el("span", "fps-set-scene__tag", "Preview"));
  return root;
}

const OUTLINE_WIDTH = { off: 0, thin: 2.2, bold: 4.5 };
const BOOST_BRIGHTNESS = { off: 1, some: 1.18, lots: 1.4 };

export class GameplayPage {
  readonly root: HTMLElement;
  private hitUntil = 0;
  private hitTimer = 0;

  constructor(private readonly host: FieldHost) {
    this.root = el("div", "fps-set-gameplay");
    this.root.append(this.buildTeams(), this.buildCrosshair(), this.buildView());
  }

  destroy(): void {
    window.clearTimeout(this.hitTimer);
  }

  private buildTeams(): HTMLElement {
    const root = card("Who's who", "Your side, and everyone you can shoot", "fps-set-card--wide");
    const split = el("div", "fps-set-split");
    const preview = scene("washoi_dm5");
    const figures = el("div", "fps-set-figures");
    figures.append(figure("ally", "Your side"), figure("enemy", "", true), figure("enemy", "Enemy"));
    preview.append(figures);
    const fields = el("div", "fps-set-stack");
    split.append(preview, fields);
    root.append(split);

    const colorChoices = TEAM_COLORS.map((color) => ({ value: color, label: color.label, css: color.css }));
    const sideField = (side: Side, name: string, help?: string) => {
      const row = el("div", "fps-set-team-row");
      fields.append(row);
      swatches<TeamColor>(this.host, row, {
        name,
        help,
        choices: colorChoices,
        get: () => sideColor(side),
        set: (color) => setSideColor(side, color),
        blocked: () => {
          const other = sideColor(side === "ally" ? "enemy" : "ally");
          return other ? { value: other, why: "the other side has it" } : null;
        },
      });
      const label = el("label", "fps-set-voice");
      label.append(el("span", "fps-set-field__name", "Sounds"));
      const menu = selectMenu(
        PLAYER_VOICE_SETS.map((voice) => voice[0].toUpperCase() + voice.slice(1)),
        `${name} sounds`,
        (index) => {
          setPlayerVoiceSet(side, PLAYER_VOICE_SETS[index] as PlayerVoiceSet);
          this.host.changed();
        },
      );
      this.host.addRefresh(() => {
        menu.select(PLAYER_VOICE_SETS.indexOf(playerVoiceSet(side)));
      });
      label.append(menu.root);
      row.append(label);
    };
    sideField("ally", "Your side");
    sideField("enemy", "Enemies", "In free-for-all, that's everyone else");
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

    this.host.addRefresh(() => {
      const outline = currentChoice(OUTLINE_CHOICES)?.id ?? "thin";
      const boost = currentChoice(BOOST_CHOICES)?.id ?? "some";
      for (const box of figures.children) {
        const side = (box as HTMLElement).dataset.side as Side;
        const color = (sideColor(side) ?? TEAM_COLORS[side === "ally" ? 0 : 1]).css;
        const svg = box.querySelector("svg");
        if (!svg) continue;
        svg.style.fill = `color-mix(in srgb, ${color} 78%, hsl(250 40% 12%))`;
        svg.style.stroke = color;
        svg.style.strokeWidth = String(OUTLINE_WIDTH[outline]);
        svg.style.filter = `brightness(${BOOST_BRIGHTNESS[boost]})${outline === "off" ? "" : ` drop-shadow(0 0 6px ${color})`}`;
        (box as HTMLElement).style.setProperty("--tag", color);
      }
    });
    return root;
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
      ["show_fps", "FPS counter", "Frames per second in the top-right corner"],
      ["cl_showspeed", "Movement speed", "Your speed at the bottom of the screen"],
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
