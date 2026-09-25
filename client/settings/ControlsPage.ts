/**
 * Controls: the keyboard and mouse, coloured by what each key does; the list of
 * actions with their keys; and how the mouse feels.
 *
 * A key is changed from either end: click the key and pick what it does, or
 * click an action and press the key, click or wheel turn you want for it.
 */

import { Cvar } from "../../../../engine/core/Cvar";
import { card, el, type FieldHost, formatPercent, button as plainButton, seg, slider } from "./SettingsFields";
import {
  ACTION_GROUPS,
  ARROW_KEYS,
  actionFor,
  assignKey,
  codeName,
  codesFor,
  cvarDefault,
  FIXED_KEYS,
  groupOf,
  type InputCode,
  inputName,
  KEYBOARD_ROWS,
  MOUSE_INPUTS,
  SETTINGS_ACTIONS,
  type SettingsAction,
} from "./SettingsModel";

/** What the controls page needs from the view around it. */
export interface ControlsHost extends FieldHost {
  /** A short line at the bottom of the screen: bold parts are key or action names. */
  toast(...parts: Array<string | { bold: string }>): void;
  /** Where the key menu may not go, so it never covers the rail. */
  leftLimit(): number;
}

const MOUSE_BUTTON_CODES: Record<number, InputCode> = { 1: "mouse:middle", 2: "mouse:right" };

export class ControlsPage {
  readonly root: HTMLElement;
  private readonly caps = new Map<InputCode, HTMLButtonElement>();
  private readonly zones = new Map<InputCode, HTMLButtonElement>();
  private readonly mouseLabels = new Map<InputCode, HTMLButtonElement>();
  private readonly board: HTMLElement;
  private readonly mouseCard: HTMLElement;
  private readonly actsEl: HTMLElement;
  private readonly pop: HTMLElement;
  private listening: string | null = null;
  private popCode: InputCode | null = null;
  private popAnchor: HTMLElement | null = null;
  private eatContextMenu = false;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly host: ControlsHost) {
    this.root = el("div", "fps-set-controls");

    const keyboard = card("Keyboard", "Click a key to choose what it does", "fps-set-card--keyboard");
    this.board = el("div", "fps-set-board");
    keyboard.append(this.board);
    this.buildBoard();

    this.mouseCard = card("Mouse", undefined, "fps-set-card--mouse");
    this.mouseCard.append(this.buildMouse());

    const actions = card("What each key does", "Click an action, then press the key you want", "fps-set-card--acts");
    this.actsEl = el("div", "fps-set-acts");
    actions.append(this.actsEl);

    const feel = card("Mouse feel", undefined, "fps-set-card--feel");
    const tune = el("div", "fps-set-stack");
    feel.append(tune);
    slider(host, tune, {
      name: "Sensitivity",
      min: 0.1,
      max: 10,
      step: 0.1,
      get: () => Cvar.getNumber("m_sensitivity"),
      set: (value) => Cvar.set("m_sensitivity", value),
      initial: () => Number(cvarDefault("m_sensitivity")),
    });
    slider(host, tune, {
      name: "While aiming",
      help: "Share of your sensitivity while you hold Aim",
      min: 0.1,
      max: 1,
      step: 0.05,
      format: formatPercent,
      get: () => Cvar.getNumber("cl_ads_sensitivity"),
      set: (value) => Cvar.set("cl_ads_sensitivity", value),
      initial: () => Number(cvarDefault("cl_ads_sensitivity")),
    });
    seg(host, tune, {
      name: "Always run",
      help: "On: you run all the time, and holding Sprint walks",
      choices: [
        { value: 0, label: "Off" },
        { value: 1, label: "On" },
      ],
      get: () => (Cvar.getNumber("cl_autorun") > 0 ? 1 : 0),
      set: (value) => {
        Cvar.set("cl_autorun", value);
      },
    });

    this.root.append(keyboard, this.mouseCard, actions, feel);

    this.pop = el("div", "fps-set-pop");
    this.pop.hidden = true;
    this.pop.setAttribute("role", "dialog");
    this.pop.setAttribute("aria-label", "Choose an action");
    document.body.append(this.pop);

    host.addRefresh(() => this.render());
    this.listen();
  }

  /** Leaving the page drops a half-made change. */
  deactivate(): void {
    this.closePop();
    if (this.listening) {
      this.listening = null;
      this.renderActs();
    }
  }

  destroy(): void {
    this.deactivate();
    for (const undo of this.cleanup) undo();
    this.cleanup.length = 0;
    this.pop.remove();
  }

  // ── Building ──

  private buildBoard(): void {
    KEYBOARD_ROWS.forEach((row, index) => {
      const rowEl = el("div", `fps-set-krow${index === 0 ? " fps-set-krow--f" : ""}`);
      for (const [code, legend, width] of row) rowEl.append(this.cap(code, legend, width));
      if (index === KEYBOARD_ROWS.length - 1) {
        const arrows = el("div", "fps-set-arrows");
        for (const [code, legend] of ARROW_KEYS) arrows.append(this.cap(code, legend));
        rowEl.append(arrows);
      }
      this.board.append(rowEl);
    });
  }

  private cap(code: InputCode, legend: string, width = 1): HTMLButtonElement {
    const key = plainButton("fps-set-cap");
    key.dataset.code = code;
    key.style.setProperty("--w", String(width));
    const act = el("span", "fps-set-cap__act");
    act.append(el("span", "fps-set-cap__long"), el("span", "fps-set-cap__short"));
    key.append(el("span", "fps-set-cap__legend", legend), act);
    this.wireInput(key, code);
    this.caps.set(code, key);
    return key;
  }

  private buildMouse(): HTMLElement {
    const wrap = el("div", "fps-set-mouse-wrap");
    const mouse = el("div", "fps-set-mouse");
    const labels = el("div", "fps-set-mlabels");
    for (const { code, name } of MOUSE_INPUTS) {
      const zone = plainButton("fps-set-mzone");
      zone.dataset.code = code;
      zone.setAttribute("aria-label", name);
      this.wireInput(zone, code);
      mouse.append(zone);
      this.zones.set(code, zone);

      const label = plainButton("fps-set-mlabel");
      label.append(el("span", "fps-set-mlabel__slot", name), el("span", "fps-set-mlabel__act"));
      this.wireInput(label, code);
      labels.append(label);
      this.mouseLabels.set(code, label);
    }
    // The browser's menu would cover the mouse picture on a right click there
    this.mouseCard.addEventListener("contextmenu", (event) => event.preventDefault());
    wrap.append(mouse, labels);
    return wrap;
  }

  /** A key cap, a mouse zone or its label: all open the menu and light their action. */
  private wireInput(target: HTMLElement, code: InputCode): void {
    target.addEventListener("click", () => {
      if (FIXED_KEYS.has(code)) this.sayFixed(code);
      else this.openPop(code, target);
    });
    target.addEventListener("mouseenter", () => this.focusAction(actionFor(code)?.id ?? null));
    target.addEventListener("mouseleave", () => this.focusAction(null));
  }

  // ── Drawing ──

  private render(): void {
    this.renderKeys();
    this.renderActs();
  }

  private renderKeys(): void {
    for (const [code, key] of this.caps) {
      const action = actionFor(code);
      const fixed = FIXED_KEYS.has(code);
      key.classList.toggle("is-bound", action !== null);
      key.classList.toggle("is-fixed", fixed);
      key.style.setProperty("--c", action ? groupOf(action).color : "");
      const long = action ? (action.onKey ?? action.name) : "";
      key.querySelector(".fps-set-cap__long")!.textContent = long;
      key.querySelector(".fps-set-cap__short")!.textContent = action ? (action.onNarrowKey ?? long) : "";
      key.setAttribute(
        "aria-label",
        `${inputName(code)}: ${action ? `${action.name}${fixed ? " (fixed)" : ""}` : "nothing"}`,
      );
      key.title = key.getAttribute("aria-label") ?? "";
    }
    for (const [code, zone] of this.zones) {
      const action = actionFor(code);
      zone.classList.toggle("is-bound", action !== null);
      zone.style.setProperty("--c", action ? groupOf(action).color : "");
      zone.setAttribute("aria-label", `${inputName(code)}: ${action?.name ?? "nothing"}`);
    }
    for (const [code, label] of this.mouseLabels) {
      const action = actionFor(code);
      label.classList.toggle("is-empty", action === null);
      label.style.setProperty("--c", action ? groupOf(action).color : "");
      label.querySelector(".fps-set-mlabel__act")!.textContent = action?.name ?? "Nothing";
    }
  }

  private renderActs(): void {
    const columns = ACTION_GROUPS.map((group) => {
      const column = el("div", "fps-set-act-group");
      column.style.setProperty("--c", group.color);
      column.append(el("h3", "fps-set-act-group__title", group.name));
      for (const action of SETTINGS_ACTIONS.filter((item) => item.group === group.id)) {
        column.append(this.actRow(action));
      }
      return column;
    });
    this.actsEl.replaceChildren(...columns);
  }

  private actRow(action: SettingsAction): HTMLElement {
    const codes = codesFor(action.id);
    const row = plainButton(
      [
        "fps-set-act",
        codes.length === 0 ? "is-empty" : "",
        action.fixed ? "is-fixed" : "",
        this.listening === action.id ? "is-listening" : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    row.dataset.action = action.id;
    const name = el("span", "fps-set-act__name", action.name);
    if (action.fixed) name.append(el("span", "fps-set-act__fixed", "Fixed"));
    const keys = el("span", "fps-set-act__keys");
    for (const code of codes) {
      const chip = el("span", `fps-set-chip${action.fixed ? " fps-set-chip--fixed" : ""}`, codeName(code));
      if (!action.fixed) {
        const remove = el("span", "fps-set-chip__x", "×");
        remove.title = `Take ${codeName(code)} off ${action.name}`;
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          this.assign(code, null);
        });
        chip.append(remove);
      }
      keys.append(chip);
    }
    if (codes.length === 0) keys.append(el("span", "fps-set-chip fps-set-chip--none", "none"));
    if (this.listening === action.id) keys.append(el("span", "fps-set-act__listen", "Press a key, wheel or button…"));
    row.append(name, keys);
    row.setAttribute(
      "aria-label",
      action.fixed
        ? `${action.name}: ${codes.map(codeName).join(", ")}, fixed`
        : `${action.name}: ${codes.length ? codes.map(codeName).join(", ") : "no key"}. Press to give it a key`,
    );
    if (action.fixed) row.addEventListener("click", () => this.sayFixed(action.fixed!.codes[0]));
    else row.addEventListener("click", () => this.toggleListening(action.id));
    row.addEventListener("mouseenter", () => this.focusAction(action.id));
    row.addEventListener("mouseleave", () => this.focusAction(null));
    return row;
  }

  /** Pointing at an action lights its keys; pointing at a key lights its action. */
  private focusAction(id: string | null): void {
    const lit = new Set(id ? codesFor(id) : []);
    this.board.classList.toggle("is-focusing", id !== null);
    this.mouseCard.classList.toggle("is-focusing", id !== null);
    for (const [code, key] of this.caps) key.classList.toggle("is-focus", lit.has(code));
    for (const [code, zone] of this.zones) zone.classList.toggle("is-focus", lit.has(code));
    for (const [code, label] of this.mouseLabels) label.classList.toggle("is-focus", lit.has(code));
    for (const row of this.actsEl.querySelectorAll<HTMLElement>(".fps-set-act")) {
      row.classList.toggle("is-hl", row.dataset.action === id);
    }
  }

  private flash(code: InputCode): void {
    const target = this.caps.get(code) ?? this.zones.get(code);
    if (!target) return;
    target.classList.remove("is-flash");
    void target.offsetWidth;
    target.classList.add("is-flash");
  }

  // ── Changing keys ──

  private assign(code: InputCode, actionId: string | null): void {
    const result = assignKey(code, actionId);
    if (result.kind === "fixed") {
      this.sayFixed(code);
      return;
    }
    this.host.changed();
    this.flash(code);
    const key = { bold: codeName(code) };
    if (result.kind === "cleared") this.host.toast(key, " does nothing now");
    else if (result.previous && result.previous.id !== result.action.id) {
      this.host.toast(key, ` was ${result.previous.name}, now ${result.action.name}`);
    } else if (!result.previous) this.host.toast(key, " → ", { bold: result.action.name });
  }

  private sayFixed(code: InputCode): void {
    const action = FIXED_KEYS.get(code);
    if (action?.fixed)
      this.host.toast({ bold: codeName(code) }, ` always ${action.fixed.does}. That can't be changed yet`);
  }

  private toggleListening(id: string): void {
    this.closePop();
    this.listening = this.listening === id ? null : id;
    this.renderActs();
  }

  private takeInput(code: InputCode): void {
    if (FIXED_KEYS.has(code)) {
      this.sayFixed(code);
      return;
    }
    const id = this.listening;
    this.listening = null;
    this.assign(code, id);
  }

  /** Press-to-bind: the next key, click or wheel turn goes to the waiting action. Esc cancels. */
  private listen(): void {
    const onKey = (event: KeyboardEvent) => {
      if (this.listening) {
        event.preventDefault();
        event.stopPropagation();
        if (event.code === "Escape") {
          this.listening = null;
          this.renderActs();
          return;
        }
        this.takeInput(event.code);
      } else if (event.code === "Escape" && this.popCode) {
        event.stopPropagation();
        this.closePop(true);
      }
    };
    const onMouse = (event: MouseEvent) => {
      if (
        this.popCode &&
        !(event.target as Element | null)?.closest?.(".fps-set-pop, .fps-set-cap, .fps-set-mzone, .fps-set-mlabel")
      ) {
        this.closePop();
      }
      if (!this.listening || (event.target as Element | null)?.closest?.(".fps-set-act")) return;
      // A left click away cancels, so reaching for another control cannot take
      // Fire's button. Left click is still yours to give from the mouse picture.
      if (event.button === 0) {
        this.listening = null;
        this.renderActs();
        return;
      }
      const code = MOUSE_BUTTON_CODES[event.button];
      if (!code) return;
      event.preventDefault();
      event.stopPropagation();
      this.eatContextMenu = event.button === 2;
      this.takeInput(code);
    };
    const onWheel = (event: WheelEvent) => {
      if (!this.listening) return;
      event.preventDefault();
      event.stopPropagation();
      this.takeInput(event.deltaY < 0 ? "wheel:up" : "wheel:down");
    };
    const onMenu = (event: MouseEvent) => {
      if (this.listening || this.eatContextMenu) event.preventDefault();
      this.eatContextMenu = false;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("contextmenu", onMenu, true);
    this.cleanup.push(() => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("contextmenu", onMenu, true);
    });
  }

  // ── The key menu ──

  private openPop(code: InputCode, anchor: HTMLElement): void {
    this.listening = null;
    this.popCode = code;
    this.popAnchor = anchor;
    const current = actionFor(code);

    const head = el("div", "fps-set-pop__head");
    const close = plainButton("fps-set-pop__close", "×");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.closePop(true));
    head.append(
      el("span", "fps-set-pop__key", inputName(code)),
      el("span", "fps-set-pop__q", "What should it do?"),
      close,
    );

    const groups = el("div", "fps-set-pop__groups");
    for (const ids of [["move"], ["weapons"], ["fight", "other"]]) {
      const column = el("div", "fps-set-pop__col");
      for (const group of ACTION_GROUPS.filter((item) => ids.includes(item.id))) {
        const box = el("div", "fps-set-pop__group");
        box.style.setProperty("--c", group.color);
        box.append(el("div", "fps-set-pop__group-title", group.name));
        const options = el("div", "fps-set-pop__opts");
        for (const action of SETTINGS_ACTIONS.filter((item) => item.group === group.id && !item.fixed)) {
          const option = plainButton(`fps-set-opt${current?.id === action.id ? " is-current" : ""}`, action.name);
          option.setAttribute("aria-pressed", String(current?.id === action.id));
          option.addEventListener("click", () => {
            this.closePop(true);
            this.assign(code, action.id);
          });
          options.append(option);
        }
        box.append(options);
        column.append(box);
      }
      groups.append(column);
    }

    const foot = el("div", "fps-set-pop__foot");
    const hint = el("span", "fps-set-pop__hint");
    if (current) hint.append("Now: ", el("b", "", current.name));
    else hint.append("Does nothing yet");
    foot.append(hint);
    if (current) {
      const unbind = plainButton("fps-set-opt fps-set-opt--unbind", "Make it do nothing");
      unbind.addEventListener("click", () => {
        this.closePop(true);
        this.assign(code, null);
      });
      foot.append(unbind);
    }

    const sheet = el("div", "fps-set-pop__card");
    sheet.append(head, groups, foot);
    this.pop.replaceChildren(sheet);
    this.pop.hidden = false;

    for (const open of this.root.querySelectorAll(".is-open")) open.classList.remove("is-open");
    anchor.classList.add("is-open");
    const rect = anchor.getBoundingClientRect();
    const width = this.pop.offsetWidth;
    const height = this.pop.offsetHeight;
    const below = rect.bottom + 12 + height < window.innerHeight;
    // Centred on the key, but kept on the stage: never over the rail
    const left = Math.max(
      this.host.leftLimit(),
      Math.min(window.innerWidth - width - 16, rect.left + rect.width / 2 - width / 2),
    );
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${below ? rect.bottom + 12 : Math.max(16, rect.top - height - 12)}px`;
    (
      this.pop.querySelector<HTMLElement>(".fps-set-opt.is-current") ??
      this.pop.querySelector<HTMLElement>(".fps-set-opt")
    )?.focus();
    this.renderActs();
  }

  private closePop(returnFocus = false): void {
    if (!this.popCode) return;
    this.pop.hidden = true;
    this.popCode = null;
    for (const open of this.root.querySelectorAll(".is-open")) open.classList.remove("is-open");
    if (returnFocus) this.popAnchor?.focus();
    this.popAnchor = null;
  }
}
