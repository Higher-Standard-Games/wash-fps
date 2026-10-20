/**
 * The controls the settings pages are made of: a slider, a row of keys to pick
 * one of, and colour swatches. Each reads its value through a getter and writes
 * it through a setter, and redraws itself when the page refreshes.
 */

import { deferPreferenceWrites, flushPreferenceWrites } from "../../../../engine/core/PreferenceStorage";
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

export interface SelectMenu {
  /** The field's button; it shows the current choice and opens the list. */
  root: HTMLButtonElement;
  /** Show this choice as the current one. */
  select(index: number): void;
}

/**
 * A drop-down in the settings style, replacing the browser's own: a button that
 * opens its list right under it. The list is placed on the page body (cards clip
 * their content) and closes on a pick, Escape, Tab, a click elsewhere, scrolling
 * or resizing. Arrow keys, Home, End, Enter and Space work as in a native one.
 */
export function selectMenu(labels: readonly string[], ariaLabel: string, onPick: (index: number) => void): SelectMenu {
  const root = button("fps-set-voice__select fps-set-menu__button");
  root.setAttribute("aria-haspopup", "listbox");
  root.setAttribute("aria-expanded", "false");
  root.setAttribute("aria-label", ariaLabel);
  const text = el("span", "fps-set-menu__value");
  root.append(text, el("span", "fps-set-menu__chevron"));
  let current = 0;
  let list: HTMLUListElement | null = null;
  let active = 0;

  const highlight = (index: number) => {
    if (!list) return;
    active = (index + labels.length) % labels.length;
    list.querySelectorAll<HTMLElement>("[role=option]").forEach((option, i) => {
      option.classList.toggle("is-active", i === active);
      if (i === active) {
        root.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView?.({ block: "nearest" });
      }
    });
  };
  const close = (refocus = false) => {
    if (!list) return;
    list.remove();
    list = null;
    root.setAttribute("aria-expanded", "false");
    root.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("scroll", dismiss, true);
    if (refocus) root.focus();
  };
  const pick = (index: number) => {
    close(true);
    if (index === current) return;
    current = index;
    text.textContent = labels[index] ?? "";
    onPick(index);
  };
  const dismiss = () => close();
  const outside = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (root.contains(target) || list?.contains(target))) return;
    close();
  };
  const open = () => {
    if (list) return;
    list = el("ul", "fps-set-menu");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", ariaLabel);
    labels.forEach((label, index) => {
      const option = el("li", "fps-set-menu__option", label);
      option.id = `fps-set-menu-${Math.random().toString(36).slice(2)}-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === current));
      if (index === current) option.classList.add("is-current");
      option.addEventListener("pointerenter", () => highlight(index));
      option.addEventListener("click", () => pick(index));
      list?.append(option);
    });
    document.body.append(list);
    const rect = root.getBoundingClientRect();
    list.style.minWidth = `${rect.width}px`;
    list.style.left = `${rect.left}px`;
    // Right under the field; above it only when the window has no room below
    const height = list.offsetHeight;
    const below = rect.bottom + 6 + height <= window.innerHeight || rect.top - 6 - height < 0;
    list.style.top = `${below ? rect.bottom + 6 : rect.top - 6 - height}px`;
    root.setAttribute("aria-expanded", "true");
    highlight(current);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
  };

  root.addEventListener("click", () => (list ? close() : open()));
  root.addEventListener("keydown", (event) => {
    const handled = (() => {
      if (!list) {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
          open();
          return true;
        }
        return false;
      }
      switch (event.key) {
        case "ArrowDown":
          highlight(active + 1);
          return true;
        case "ArrowUp":
          highlight(active - 1);
          return true;
        case "Home":
          highlight(0);
          return true;
        case "End":
          highlight(labels.length - 1);
          return true;
        case "Enter":
        case " ":
          pick(active);
          return true;
        case "Escape":
          close(true);
          return true;
        case "Tab":
          close();
          return false;
        default:
          return false;
      }
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  return {
    root,
    select(index: number) {
      current = Math.max(0, Math.min(labels.length - 1, index));
      text.textContent = labels[current] ?? "";
    },
  };
}

/** What a page hands its controls: somewhere to redraw from, and a way to say a value changed. */
export interface FieldHost {
  addRefresh(refresh: () => void): void;
  /** A value changed: redraw every control, since one choice can move others. */
  changed(): void;
  /** High-frequency input may coalesce dependent visual refreshes. */
  changedSoon?(): void;
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

function trackEnabled(host: FieldHost, root: HTMLElement, options: FieldOptions, disableChildren = true): void {
  const enabledIf = options.enabledIf;
  if (enabledIf)
    host.addRefresh(() => {
      const disabled = !enabledIf();
      root.setAttribute("aria-disabled", String(disabled));
      if (!disableChildren) return;
      for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) {
        control.disabled = disabled;
      }
    });
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
    if (options.enabledIf && !options.enabledIf()) return;
    const next = Number(range.value);
    deferPreferenceWrites(() => options.set(next));
    draw(next);
    if (host.changedSoon) host.changedSoon();
    else host.changed();
  });
  range.addEventListener("change", flushPreferenceWrites);
  range.addEventListener("blur", flushPreferenceWrites);
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
      if (options.enabledIf && !options.enabledIf()) return;
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
      if (options.enabledIf && !options.enabledIf()) return;
      if (options.blocked?.()?.value === choice.value) return;
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
      key.disabled =
        (options.enabledIf !== undefined && !options.enabledIf()) ||
        (blocked !== null && blocked.value === choice.value);
      key.title = key.disabled && blocked ? `${choice.label}: ${blocked.why}` : choice.label;
      key.setAttribute("aria-label", key.title);
    }
  });
  trackEnabled(host, root, options, false);
  parent.append(root);
  return root;
}

export interface DropdownOptions<T> extends FieldOptions {
  /** `help` here explains that choice, shown under the field while it is picked. */
  choices: Array<{ value: T; label: string; help?: string }>;
  get: () => T;
  set: (value: T) => void;
}

/** A drop-down for choices too long for a segmented row, each with its own explanation. */
export function dropdown<T>(host: FieldHost, parent: HTMLElement, options: DropdownOptions<T>): HTMLElement {
  const { root } = field(options);
  const menu = selectMenu(
    options.choices.map((choice) => choice.label),
    options.name,
    (index) => {
      const choice = options.choices[index];
      if (choice) options.set(choice.value);
      host.changed();
    },
  );
  const select = menu.root;
  select.classList.add("fps-set-select");
  const explain = el("div", "fps-set-field__help fps-set-select__help");
  host.addRefresh(() => {
    const current = options.get();
    const index = options.choices.findIndex((choice) => choice.value === current);
    menu.select(Math.max(0, index));
    const help = options.choices[index]?.help ?? "";
    explain.textContent = help;
    explain.hidden = help === "";
  });
  root.insertBefore(select, root.children[1] ?? null);
  root.append(explain);
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
