/**
 * The controls the settings pages are made of: a slider, a row of keys to pick
 * one of, and colour swatches. Each reads its value through a getter and writes
 * it through a setter, and redraws itself when the page refreshes.
 */

import type { FrameCost } from "./SettingsModel";
import { COST_WORD } from "./SettingsModel";

/** A small element with a class and, optionally, text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, text?: string): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  return node;
}

/** What a page hands its controls: somewhere to redraw from, and a way to say a value changed. */
export interface FieldHost {
  addRefresh(refresh: () => void): void;
  /** A value changed: redraw every control, since one choice can move others. */
  changed(): void;
}

export interface FieldOptions {
  name: string;
  help?: string;
  /** Frame-rate cost, as one to three pips. */
  cost?: FrameCost;
  /** When the setting takes hold, if not at once. */
  tag?: string;
  /** Greyed out while this says no. */
  enabledIf?: () => boolean;
  /** Left out while this says no: for a setting whose system has not started. */
  shownIf?: () => boolean;
}

export function costPips(cost: FrameCost): HTMLElement {
  const pips = el("span", `fps-set-cost fps-set-cost--${cost}`);
  pips.title = `Frame-rate cost: ${COST_WORD[cost].toLowerCase()}`;
  pips.append(el("i"), el("i"), el("i"));
  return pips;
}

function field(options: FieldOptions): { root: HTMLElement; top: HTMLElement } {
  const root = el("div", "fps-set-field");
  const top = el("div", "fps-set-field__top");
  const label = el("span", "fps-set-field__name", options.name);
  if (options.tag) label.append(el("span", "fps-set-field__tag", options.tag));
  if (options.cost) label.append(costPips(options.cost));
  top.append(label);
  root.append(top);
  if (options.help) root.append(el("div", "fps-set-field__help", options.help));
  return { root, top };
}

function trackEnabled(host: FieldHost, root: HTMLElement, options: FieldOptions): void {
  const enabledIf = options.enabledIf;
  if (enabledIf) host.addRefresh(() => root.setAttribute("aria-disabled", String(!enabledIf())));
  const shownIf = options.shownIf;
  if (shownIf) {
    host.addRefresh(() => {
      root.hidden = !shownIf();
    });
  }
}

export const formatNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
export const formatPercent = (value: number): string => `${Math.round(value * 100)}%`;

export interface SliderOptions extends FieldOptions {
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (value: number) => void;
  /** The game's default, marked beside the value when it is the one set. */
  initial?: () => number | undefined;
  format?: (value: number) => string;
}

export function slider(host: FieldHost, parent: HTMLElement, options: SliderOptions): HTMLElement {
  const { root, top } = field(options);
  const value = el("span", "fps-set-field__val");
  top.append(value);
  const range = el("input", "fps-set-range");
  range.type = "range";
  range.min = String(options.min);
  range.max = String(options.max);
  range.step = String(options.step);
  range.setAttribute("aria-label", options.name);
  root.insertBefore(range, root.children[1] ?? null);
  const format = options.format ?? formatNumber;
  const draw = (current: number) => {
    range.style.setProperty("--pct", `${((current - options.min) / (options.max - options.min)) * 100}%`);
    value.textContent = format(current);
    const initial = options.initial?.();
    value.classList.toggle("is-default", initial !== undefined && Math.abs(initial - current) < 1e-6);
  };
  range.addEventListener("input", () => {
    const next = Number(range.value);
    options.set(next);
    draw(next);
    host.changed();
  });
  host.addRefresh(() => {
    const current = options.get();
    range.value = String(current);
    draw(current);
  });
  trackEnabled(host, root, options);
  parent.append(root);
  return root;
}

export interface SegOptions<T> extends FieldOptions {
  choices: Array<{ value: T; label: string }>;
  /** The value picked now, or null when none of the choices is. */
  get: () => T | null;
  set: (value: T) => void | Promise<void>;
}

export function seg<T>(host: FieldHost, parent: HTMLElement, options: SegOptions<T>): HTMLElement {
  const { root } = field(options);
  const row = el("div", "fps-set-seg");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", options.name);
  const keys = options.choices.map((choice) => {
    const key = button("fps-set-seg__btn", choice.label);
    key.addEventListener("click", async () => {
      await options.set(choice.value);
      host.changed();
    });
    row.append(key);
    return { choice, key };
  });
  root.insertBefore(row, root.children[1] ?? null);
  host.addRefresh(() => {
    const current = options.get();
    for (const { choice, key } of keys) {
      const on = current !== null && choice.value === current;
      key.classList.toggle("is-on", on);
      key.setAttribute("aria-pressed", String(on));
    }
  });
  trackEnabled(host, root, options);
  parent.append(root);
  return root;
}

export interface SwatchOptions<T> extends FieldOptions {
  choices: Array<{ value: T; label: string; css: string }>;
  get: () => T | null;
  set: (value: T) => void;
  /** A value that cannot be picked now, and why. */
  blocked?: () => { value: T; why: string } | null;
}

export function swatches<T>(host: FieldHost, parent: HTMLElement, options: SwatchOptions<T>): HTMLElement {
  const { root } = field(options);
  const row = el("div", "fps-set-swatches");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", options.name);
  const keys = options.choices.map((choice) => {
    const key = button("fps-set-sw");
    key.style.setProperty("--sw", choice.css);
    key.addEventListener("click", () => {
      options.set(choice.value);
      host.changed();
    });
    row.append(key);
    return { choice, key };
  });
  root.insertBefore(row, root.children[1] ?? null);
  host.addRefresh(() => {
    const current = options.get();
    const blocked = options.blocked?.() ?? null;
    for (const { choice, key } of keys) {
      const on = current !== null && choice.value === current;
      key.classList.toggle("is-on", on);
      key.setAttribute("aria-pressed", String(on));
      key.disabled = blocked !== null && blocked.value === choice.value;
      key.title = key.disabled && blocked ? `${choice.label}: ${blocked.why}` : choice.label;
      key.setAttribute("aria-label", key.title);
    }
  });
  trackEnabled(host, root, options);
  parent.append(root);
  return root;
}

/** A dark card with a title, and an optional note beside it. */
export function card(title: string, note?: string, extraClass = ""): HTMLElement {
  const root = el("section", `fps-set-card ${extraClass}`.trim());
  const heading = el("h2", "fps-set-card__title", title);
  if (note) heading.append(el("small", "", note));
  root.append(heading);
  return root;
}
