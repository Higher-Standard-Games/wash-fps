/**
 * What the settings screen offers, in plain data: the actions and the keys that
 * do them, the video presets, and the colour choices for players and the
 * crosshair. Every choice writes the game's own cvars and bindings; nothing here
 * is a setting of its own.
 */

import { Cvar, type CvarValue } from "../../../../engine/core/Cvar";
import { InputSystem } from "../../../../engine/input/InputSystem";
import type { InputBinding } from "../../../../engine/input/InputTypes";
import { FPS } from "../FPSActions";

// ═══════════════════════════════ KEYS ═══════════════════════════════

/**
 * One physical input, as the screen names it: a keyboard `code` ("KeyW"),
 * "mouse:left|right|middle" or "wheel:up|down".
 */
export type InputCode = string;

export type ActionGroupId = "move" | "weapons" | "fight" | "other";

export interface ActionGroup {
  id: ActionGroupId;
  name: string;
  /** The colour its keys, chips and list are drawn in. */
  color: string;
}

export const ACTION_GROUPS: ActionGroup[] = [
  { id: "move", name: "Move", color: "hsl(182 95% 52%)" },
  { id: "weapons", name: "Weapons", color: "hsl(46 100% 57%)" },
  { id: "fight", name: "Fight", color: "hsl(322 95% 62%)" },
  { id: "other", name: "Other", color: "hsl(276 90% 70%)" },
];

export interface SettingsAction {
  /** The InputSystem action, or a stand-in id for a key the game reads directly. */
  id: string;
  group: ActionGroupId;
  name: string;
  /** Written on a key where the name fits, and where it does not. */
  onKey?: string;
  onNarrowKey?: string;
  /**
   * Set when the game reads the key itself rather than through a binding: the
   * keys it answers to, and what they do.
   */
  fixed?: { codes: InputCode[]; does: string };
}

/**
 * Only what the game acts on. A player carries three weapons (the blade and two
 * picked up), so the weapon keys stop at three. The scoreboard, chat, console and
 * join keys are read directly by the game, so they show as fixed rather than as
 * bindings that would do nothing.
 */
export const SETTINGS_ACTIONS: SettingsAction[] = [
  { id: FPS.MOVE_FORWARD, group: "move", name: "Forward", onNarrowKey: "Fwd" },
  { id: FPS.MOVE_BACKWARD, group: "move", name: "Back" },
  { id: FPS.MOVE_LEFT, group: "move", name: "Left" },
  { id: FPS.MOVE_RIGHT, group: "move", name: "Right" },
  { id: FPS.JUMP, group: "move", name: "Jump" },
  { id: FPS.CROUCH, group: "move", name: "Crouch / slide", onKey: "Crouch", onNarrowKey: "Crch" },
  { id: FPS.SPRINT, group: "move", name: "Sprint", onNarrowKey: "Sprnt" },
  { id: FPS.WEAPON_1, group: "weapons", name: "Blade" },
  { id: FPS.WEAPON_2, group: "weapons", name: "Primary", onNarrowKey: "Pri" },
  { id: FPS.WEAPON_3, group: "weapons", name: "Secondary", onKey: "Second.", onNarrowKey: "Sec" },
  { id: FPS.WEAPON_NEXT, group: "weapons", name: "Next weapon", onKey: "Next wpn", onNarrowKey: "Next" },
  { id: FPS.WEAPON_PREV, group: "weapons", name: "Previous weapon", onKey: "Prev wpn", onNarrowKey: "Prev" },
  { id: FPS.FIRE, group: "fight", name: "Fire" },
  { id: FPS.AIM, group: "fight", name: "Aim" },
  { id: FPS.RELOAD, group: "fight", name: "Reload", onNarrowKey: "Rld" },
  { id: FPS.USE, group: "fight", name: "Use", onKey: "Use" },
  { id: FPS.READY, group: "other", name: "Ready" },
  {
    id: "cancel",
    group: "other",
    name: "Menu / cancel",
    onKey: "Menu",
    fixed: { codes: ["Escape"], does: "opens the match menu or cancels a dialog" },
  },
  {
    id: FPS.SCOREBOARD,
    group: "other",
    name: "Scoreboard",
    onKey: "Scores",
    onNarrowKey: "Score",
    fixed: { codes: ["Tab"], does: "opens the scoreboard" },
  },
  { id: FPS.CHAT, group: "other", name: "Chat", fixed: { codes: ["KeyT", "Enter"], does: "opens chat" } },
  { id: FPS.TEAM_CHAT, group: "other", name: "Team chat", fixed: { codes: ["KeyY"], does: "opens team chat" } },
  {
    id: FPS.CONSOLE,
    group: "other",
    name: "Console",
    onNarrowKey: "Con",
    fixed: { codes: ["Backquote"], does: "opens the console" },
  },
  {
    id: FPS.JOIN_GAME,
    group: "other",
    name: "Join game",
    onKey: "Join",
    fixed: { codes: ["KeyJ"], does: "joins the game" },
  },
];

/**
 * Actions the screen does not list but that hold keys by default: slots four to
 * nine. Giving one of their keys to a listed action takes it from them too, so a
 * key never does two things.
 */
const UNLISTED_ACTIONS: string[] = [FPS.WEAPON_4, FPS.WEAPON_5, FPS.WEAPON_6, FPS.WEAPON_7, FPS.WEAPON_8, FPS.WEAPON_9];

const ACTION_BY_ID = new Map(SETTINGS_ACTIONS.map((action) => [action.id, action]));
export const groupOf = (action: SettingsAction): ActionGroup =>
  ACTION_GROUPS.find((group) => group.id === action.group) ?? ACTION_GROUPS[0];

/** Key code → the fixed action that owns it. */
export const FIXED_KEYS = new Map<InputCode, SettingsAction>(
  SETTINGS_ACTIONS.flatMap((action) => (action.fixed ? action.fixed.codes.map((code) => [code, action]) : [])),
);

/** A keyboard: code, legend, and width in key units. */
export type KeyCap = [code: InputCode, legend: string, width?: number];

const letters = (text: string): KeyCap[] => [...text].map((char) => [`Key${char}`, char]);

/** Fifteen keys wide, with the arrows tucked into the bottom row like a laptop's. */
export const KEYBOARD_ROWS: KeyCap[][] = [
  [["Escape", "Esc"], ...Array.from({ length: 12 }, (_, i): KeyCap => [`F${i + 1}`, `F${i + 1}`])],
  [
    ["Backquote", "`"],
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n): KeyCap => [`Digit${n}`, String(n)]),
    ["Minus", "-"],
    ["Equal", "="],
    ["Backspace", "⌫", 2],
  ],
  [
    ["Tab", "Tab", 1.5],
    ...letters("QWERTYUIOP"),
    ["BracketLeft", "["],
    ["BracketRight", "]"],
    ["Backslash", "\\", 1.5],
  ],
  [["CapsLock", "Caps", 1.75], ...letters("ASDFGHJKL"), ["Semicolon", ";"], ["Quote", "'"], ["Enter", "Enter", 2.25]],
  [
    ["ShiftLeft", "Shift", 2.25],
    ...letters("ZXCVBNM"),
    ["Comma", ","],
    ["Period", "."],
    ["Slash", "/"],
    ["ShiftRight", "Shift", 2.75],
  ],
  [
    ["ControlLeft", "Ctrl", 1.25],
    ["MetaLeft", "Win", 1.25],
    ["AltLeft", "Alt", 1.25],
    ["Space", "Space", 5.75],
    ["AltRight", "Alt", 1.25],
    ["ControlRight", "Ctrl", 1.25],
  ],
];

export const ARROW_KEYS: KeyCap[] = [
  ["ArrowUp", "↑"],
  ["ArrowLeft", "←"],
  ["ArrowDown", "↓"],
  ["ArrowRight", "→"],
];

export const MOUSE_INPUTS: Array<{ code: InputCode; name: string }> = [
  { code: "mouse:left", name: "Left click" },
  { code: "mouse:right", name: "Right click" },
  { code: "wheel:up", name: "Wheel up" },
  { code: "mouse:middle", name: "Wheel click" },
  { code: "wheel:down", name: "Wheel down" },
];

const LEGEND = new Map<InputCode, string>(
  [...KEYBOARD_ROWS.flat(), ...ARROW_KEYS].map(([code, legend]) => [code, legend]),
);
const CHIP: Record<string, string> = {
  ShiftLeft: "L-Shift",
  ShiftRight: "R-Shift",
  ControlLeft: "L-Ctrl",
  ControlRight: "R-Ctrl",
  AltLeft: "L-Alt",
  AltRight: "R-Alt",
  "mouse:left": "L-Click",
  "mouse:right": "R-Click",
  "mouse:middle": "Wheel",
  "wheel:up": "Wheel ↑",
  "wheel:down": "Wheel ↓",
};

/** What a key is called on a chip: short, and the same wherever it appears. */
export function codeName(code: InputCode): string {
  return CHIP[code] ?? LEGEND.get(code) ?? code.replace(/^Key|^Digit/, "");
}

/** What a key is called on its own: the legend on the cap, or the mouse part. */
export function inputName(code: InputCode): string {
  return MOUSE_INPUTS.find((input) => input.code === code)?.name ?? LEGEND.get(code) ?? codeName(code);
}

export function bindingToCode(binding: InputBinding): InputCode | null {
  if (binding.modifiers) return null;
  if (binding.key) return binding.key;
  if (binding.mouseButton) return `mouse:${binding.mouseButton}`;
  if (binding.scrollDirection) return `wheel:${binding.scrollDirection}`;
  return null;
}

export function codeToBinding(code: InputCode): InputBinding {
  if (code.startsWith("mouse:")) return { mouseButton: code.slice(6) as InputBinding["mouseButton"] };
  if (code.startsWith("wheel:")) return { scrollDirection: code.slice(6) as "up" | "down" };
  return { key: code };
}

/**
 * The keys an action answers to, in the order they were given. A fixed action
 * answers to the game's keys whatever was saved for it.
 */
export function codesFor(actionId: string, input: InputSystem = InputSystem.getInstance()): InputCode[] {
  const fixed = ACTION_BY_ID.get(actionId)?.fixed;
  if (fixed) return [...fixed.codes];
  const codes: InputCode[] = [];
  for (const binding of input.getBindingsForAction(actionId)) {
    const code = bindingToCode(binding);
    if (code && !codes.includes(code) && !FIXED_KEYS.has(code)) codes.push(code);
  }
  return codes;
}

/** The listed action a key does, if any. */
export function actionFor(code: InputCode, input: InputSystem = InputSystem.getInstance()): SettingsAction | null {
  const fixed = FIXED_KEYS.get(code);
  if (fixed) return fixed;
  return SETTINGS_ACTIONS.find((action) => !action.fixed && codesFor(action.id, input).includes(code)) ?? null;
}

function sameCodes(a: InputCode[], b: InputCode[]): boolean {
  return a.length === b.length && a.every((code, index) => code === b[index]);
}

function defaultCodes(actionId: string, input: InputSystem): InputCode[] {
  return input.getDefaultBindings(actionId).flatMap((binding) => bindingToCode(binding) ?? []);
}

function setCodes(actionId: string, codes: InputCode[], input: InputSystem): void {
  // Matching the defaults again is stored as "no override", so a later change
  // to the defaults reaches this player too
  if (sameCodes(codes, defaultCodes(actionId, input))) input.resetBinding(actionId);
  else input.rebind(actionId, codes.map(codeToBinding));
}

export type AssignResult =
  | { kind: "fixed"; action: SettingsAction }
  | { kind: "cleared"; previous: SettingsAction | null }
  | { kind: "assigned"; action: SettingsAction; previous: SettingsAction | null };

/**
 * Give `code` to `actionId`, or to nothing when `actionId` is null. A key does
 * one thing: giving it to an action takes it from whichever action had it.
 */
export function assignKey(
  code: InputCode,
  actionId: string | null,
  input: InputSystem = InputSystem.getInstance(),
): AssignResult {
  const fixed = FIXED_KEYS.get(code);
  if (fixed) return { kind: "fixed", action: fixed };
  const previous = actionFor(code, input);
  for (const id of [
    ...SETTINGS_ACTIONS.filter((action) => !action.fixed).map((action) => action.id),
    ...UNLISTED_ACTIONS,
  ]) {
    const current = input.getBindingsForAction(id).flatMap((binding) => bindingToCode(binding) ?? []);
    if (current.includes(code))
      setCodes(
        id,
        current.filter((other) => other !== code),
        input,
      );
  }
  const action = actionId ? ACTION_BY_ID.get(actionId) : undefined;
  if (!action || action.fixed) return { kind: "cleared", previous };
  setCodes(action.id, [...codesFor(action.id, input), code], input);
  return { kind: "assigned", action, previous };
}

/** Every listed action, and the slots it hides, back to the game's keys. */
export function resetKeys(input: InputSystem = InputSystem.getInstance()): void {
  for (const action of SETTINGS_ACTIONS) input.resetBinding(action.id);
  for (const id of UNLISTED_ACTIONS) input.resetBinding(id);
}

// ═══════════════════════════════ CVARS ═══════════════════════════════

export const cvarDefault = (name: string): CvarValue | undefined => Cvar.getCvar(name)?.defaultValue;
export const cvarNumber = (name: string): number => Cvar.getNumber(name);

/** A choice that sets several cvars at once, and knows when they are all set. */
export interface CvarChoice<Id extends string = string> {
  id: Id;
  label: string;
  values: Record<string, CvarValue>;
}

function valueMatches(current: CvarValue | undefined, wanted: CvarValue): boolean {
  if (typeof wanted === "number") return typeof current === "number" && Math.abs(current - wanted) < 1e-6;
  if (typeof wanted === "boolean") return current === wanted || current === (wanted ? 1 : 0);
  return (
    String(current ?? "")
      .trim()
      .toUpperCase() === wanted.toUpperCase()
  );
}

/** The choice whose every value is set now, or null for a mix of one's own. */
export function currentChoice<C extends CvarChoice>(choices: readonly C[]): C | null {
  return (
    choices.find((choice) =>
      Object.entries(choice.values).every(([name, value]) => valueMatches(Cvar.get(name), value)),
    ) ?? null
  );
}

export function applyChoice(choice: CvarChoice): void {
  for (const [name, value] of Object.entries(choice.values)) Cvar.set(name, value);
}

// ── Video presets ──

/**
 * Presets set only what costs frames; brightness, outlines and the like are left
 * alone. Balanced is the game's own defaults.
 */
export const VIDEO_PRESETS: Array<CvarChoice<"smooth" | "balanced" | "pretty"> & { line: string; bars: number }> = [
  {
    id: "smooth",
    label: "Smooth",
    line: "The most frames. Plain water, no light shafts, no bloom.",
    bars: 1,
    values: {
      r_bloom: 0,
      r_glow: 0,
      r_ssr: 0,
      r_ssr_strength: 0.4,
      r_anisotropy: 4,
      r_picmip: 1,
      r_godrays: 0,
      r_water_quality: 1,
      r_water_actors: 0,
      r_arealights: 0,
      r_bsp_pbr: 0,
    },
  },
  {
    id: "balanced",
    label: "Balanced",
    line: "The look the game ships with.",
    bars: 2,
    values: {
      r_bloom: 1,
      r_glow: 0,
      r_ssr: 0,
      r_ssr_strength: 0.4,
      r_anisotropy: 8,
      r_picmip: 0,
      r_godrays: 1,
      r_godrays_samples: 60,
      r_water_quality: 2,
      r_water_actors: 1,
      r_arealights: 1,
      r_bsp_pbr: 1,
    },
  },
  {
    id: "pretty",
    label: "Pretty",
    line: "Adds glow, reflections and see-through water. Wants a strong graphics card.",
    bars: 3,
    values: {
      r_bloom: 1.3,
      // A hint of glow on lit strips and signs; more turns every lamp into a blurred blob
      r_glow: 0.35,
      r_ssr: 1,
      r_ssr_strength: 0.5,
      r_anisotropy: 16,
      r_picmip: 0,
      r_godrays: 1,
      r_godrays_samples: 60,
      r_water_quality: 3,
      r_water_actors: 1,
      r_arealights: 1,
      r_bsp_pbr: 1,
    },
  },
];

/** Light shafts: one choice over the gate and the sample count. */
export const GODRAY_CHOICES: CvarChoice<"off" | "low" | "high">[] = [
  { id: "off", label: "Off", values: { r_godrays: 0 } },
  { id: "low", label: "Low", values: { r_godrays: 1, r_godrays_samples: 30 } },
  { id: "high", label: "High", values: { r_godrays: 1, r_godrays_samples: 60 } },
];

/** Off is off whatever the sample count; on, fewer samples than halfway to high is low. */
export function godrayChoice(): (typeof GODRAY_CHOICES)[number] {
  if (cvarNumber("r_godrays") < 0.5) return GODRAY_CHOICES[0];
  return cvarNumber("r_godrays_samples") > 45 ? GODRAY_CHOICES[2] : GODRAY_CHOICES[1];
}

export type FrameCost = "low" | "mid" | "high";
export const COST_WORD: Record<FrameCost, string> = { low: "Light", mid: "Medium", high: "Heavy" };

/**
 * How heavy each video section is set, in points from the same estimates as the
 * pips on its settings (light 1, medium 2, heavy 3).
 */
export const VIDEO_SECTIONS: Array<{
  id: "screen" | "effects" | "world" | "textures" | "advanced";
  name: string;
  load: () => number;
}> = [
  { id: "screen", name: "Screen", load: () => 0 },
  {
    id: "effects",
    name: "Effects",
    load: () =>
      (cvarNumber("r_bloom") > 0 ? 1 : 0) +
      (cvarNumber("r_glow") > 0 ? 2 : 0) +
      (cvarNumber("r_ssr") > 0 ? 3 : 0) +
      { off: 0, low: 1, high: 2 }[godrayChoice().id] +
      (Cvar.getBool("r_cel_outlines") ? 1 : 0),
  },
  {
    id: "world",
    name: "World",
    load: () =>
      cvarNumber("r_water_quality") -
      1 +
      (cvarNumber("r_water_quality") >= 3 && cvarNumber("r_water_actors") > 0 ? 1 : 0) +
      (cvarNumber("r_arealights") > 0 ? 2 : 0),
  },
  {
    id: "textures",
    name: "Textures",
    load: () =>
      (cvarNumber("r_anisotropy") >= 16 ? 2 : cvarNumber("r_anisotropy") >= 4 ? 1 : 0) +
      (cvarNumber("r_bsp_pbr") > 0 ? 2 : 0),
  },
  { id: "advanced", name: "Advanced", load: () => (cvarNumber("r_picmip") === 0 ? 1 : 0) },
];

/** Up to one point is light, up to three medium, more is heavy. */
export const loadLevel = (points: number): FrameCost => (points <= 1 ? "low" : points <= 3 ? "mid" : "high");

// ── Players ──

export interface TeamColor {
  id: string;
  label: string;
  /** How the swatch looks on screen. */
  css: string;
  /** The model tint and its outline, as RGB floats at full glow. */
  fill: string;
  outline: string;
}

/**
 * Each colour sets a side's body and its outline together. Pink and cyan are the
 * game's defaults for your side and enemies.
 */
export const TEAM_COLORS: TeamColor[] = [
  { id: "pink", label: "Pink", css: "hsl(318 100% 62%)", fill: "1.55 0.2 1.35", outline: "1.85 0.28 1.65" },
  { id: "cyan", label: "Cyan", css: "hsl(190 100% 55%)", fill: "0.1 1.15 1.85", outline: "0.16 1.35 2.2" },
  { id: "lime", label: "Lime", css: "hsl(96 90% 55%)", fill: "0.55 1.7 0.2", outline: "0.7 2 0.3" },
  { id: "orange", label: "Orange", css: "hsl(28 100% 58%)", fill: "1.8 0.7 0.1", outline: "2.1 0.85 0.15" },
  { id: "yellow", label: "Yellow", css: "hsl(52 100% 58%)", fill: "1.7 1.5 0.15", outline: "2 1.8 0.2" },
  { id: "red", label: "Red", css: "hsl(356 95% 60%)", fill: "1.8 0.2 0.25", outline: "2.1 0.3 0.3" },
  { id: "violet", label: "Violet", css: "hsl(272 95% 68%)", fill: "0.9 0.3 1.9", outline: "1.1 0.4 2.2" },
  { id: "white", label: "White", css: "hsl(45 60% 95%)", fill: "1.6 1.6 1.6", outline: "1.9 1.9 1.9" },
];

export type Side = "ally" | "enemy";

/** Enemies covers free-for-all too: anyone you can shoot is one colour. */
const SIDE_CVARS: Record<Side, Array<{ fill: string; outline: string }>> = {
  ally: [{ fill: "cl_team_ally_color", outline: "cl_team_ally_outline_color" }],
  enemy: [
    { fill: "cl_team_enemy_color", outline: "cl_team_enemy_outline_color" },
    { fill: "cl_team_ffa_color", outline: "cl_team_ffa_outline_color" },
  ],
};

function sameRgb(a: string, b: string): boolean {
  const x = a.trim().split(/\s+/).map(Number);
  const y = b.trim().split(/\s+/).map(Number);
  return x.length === 3 && y.length === 3 && x.every((value, index) => Math.abs(value - y[index]) < 0.01);
}

/** The colour a side is drawn in now, or null when it was set to something else. */
export function sideColor(side: Side): TeamColor | null {
  return (
    TEAM_COLORS.find((color) =>
      SIDE_CVARS[side].every(
        (cvars) =>
          sameRgb(Cvar.getString(cvars.fill), color.fill) && sameRgb(Cvar.getString(cvars.outline), color.outline),
      ),
    ) ?? null
  );
}

export function setSideColor(side: Side, color: TeamColor): void {
  for (const cvars of SIDE_CVARS[side]) {
    Cvar.set(cvars.fill, color.fill);
    Cvar.set(cvars.outline, color.outline);
  }
}

export function resetSideColors(): void {
  for (const cvars of [...SIDE_CVARS.ally, ...SIDE_CVARS.enemy]) {
    Cvar.reset(cvars.fill);
    Cvar.reset(cvars.outline);
  }
}

/** Outline thickness: Thin is the game's default size, Bold twice it. */
export const OUTLINE_CHOICES: CvarChoice<"off" | "thin" | "bold">[] = [
  { id: "off", label: "Off", values: { cl_player_outline: 0 } },
  { id: "thin", label: "Thin", values: { cl_player_outline: 1, cl_player_outline_size: 25 } },
  { id: "bold", label: "Bold", values: { cl_player_outline: 1, cl_player_outline_size: 50 } },
];

/** A glow of the players' own that makes them stand out in dark corners. */
export const BOOST_CHOICES: CvarChoice<"off" | "some" | "lots">[] = [
  { id: "off", label: "Off", values: { cl_player_fullbright: 0 } },
  { id: "some", label: "Some", values: { cl_player_fullbright: 1, cl_player_fullbright_intensity: 0.25 } },
  { id: "lots", label: "Lots", values: { cl_player_fullbright: 1, cl_player_fullbright_intensity: 0.6 } },
];

// ── Crosshair ──

export interface HexColor {
  value: string;
  label: string;
}

/** The game's defaults (green, and red on a hit) are among them. */
export const CROSSHAIR_COLORS: HexColor[] = [
  { value: "00FF00", label: "Green" },
  { value: "00E7FF", label: "Cyan" },
  { value: "FFB400", label: "Amber" },
  { value: "F4F7FF", label: "White" },
  { value: "FF4FD8", label: "Magenta" },
  { value: "FF3355", label: "Red" },
];

export const HIT_COLORS: HexColor[] = [
  { value: "FF0000", label: "Red" },
  { value: "F4F7FF", label: "White" },
  { value: "FFB400", label: "Amber" },
  { value: "FF4FD8", label: "Magenta" },
  { value: "00E7FF", label: "Cyan" },
];

// ── Pages ──

export type SettingsPageId = "controls" | "gameplay" | "video" | "audio";

export const SETTINGS_PAGES: Array<{ id: SettingsPageId; title: string; hint: string; ghost: string }> = [
  { id: "controls", title: "Controls", hint: "Keys · mouse", ghost: "KEYS" },
  { id: "gameplay", title: "Gameplay", hint: "Aim · colours", ghost: "AIM" },
  { id: "video", title: "Video", hint: "Quality", ghost: "VIDEO" },
  { id: "audio", title: "Audio", hint: "Volume", ghost: "SOUND" },
];

/** The cvars each page's reset puts back. Controls also puts back every key. */
export const PAGE_CVARS: Record<SettingsPageId, string[]> = {
  controls: ["m_sensitivity", "cl_ads_sensitivity", "cl_autorun"],
  gameplay: [
    "cl_team_ally_color",
    "cl_team_ally_outline_color",
    "cl_team_enemy_color",
    "cl_team_enemy_outline_color",
    "cl_team_ffa_color",
    "cl_team_ffa_outline_color",
    "cl_player_outline",
    "cl_player_outline_size",
    "cl_player_fullbright",
    "cl_player_fullbright_intensity",
    "cg_crosshair",
    "cg_crosshairSize",
    "cg_crosshairAlpha",
    "cg_crosshairColor",
    "cg_crosshairSpread",
    "cg_crosshairDmgColor",
    "cl_fov",
    "show_fps",
    "cl_showspeed",
    "cl_netgraph",
  ],
  video: [
    "r_picmip",
    "r_bloom",
    "r_glow",
    "r_ssr",
    "r_ssr_strength",
    "r_anisotropy",
    "r_godrays",
    "r_godrays_samples",
    "r_water_quality",
    "r_water_actors",
    "r_arealights",
    "r_bsp_pbr",
    "r_cel_outlines",
    "r_exposure",
    "r_contrast",
    "r_underwater_distortion",
  ],
  audio: [
    "s_musicenabled",
    "s_volume",
    "s_sfxenabled",
    "s_sfxvolume",
    "cg_volume_effects",
    "cg_volume_players",
    "cg_volume_hitsound",
    "cg_volume_announcer",
  ],
};

/** Put a page back to the game's defaults. */
export function resetPage(page: SettingsPageId, input: InputSystem = InputSystem.getInstance()): void {
  for (const name of PAGE_CVARS[page]) if (Cvar.exists(name)) Cvar.reset(name);
  if (page === "controls") resetKeys(input);
}
