import { button, el } from "./SettingsFields";
import {
  ARROW_KEYS,
  actionFor,
  FIXED_KEYS,
  groupOf,
  type InputCode,
  inputName,
  KEYBOARD_ROWS,
  MOUSE_INPUTS,
} from "./SettingsModel";

/** Shared Controls geometry. Without a wiring callback this is a non-interactive preview. */
export function createInputDiagram(wire?: (element: HTMLElement, code: InputCode) => void) {
  const caps = new Map<InputCode, HTMLElement>();
  const zones = new Map<InputCode, HTMLElement>();
  const labels = new Map<InputCode, HTMLElement>();
  const input = (className: string, code: InputCode) => {
    const element = wire ? button(className) : el("div", className);
    element.dataset.code = code;
    wire?.(element, code);
    return element;
  };
  const cap = (code: InputCode, legend: string, width = 1) => {
    const key = input("fps-set-cap", code);
    key.style.setProperty("--w", String(width));
    const action = el("span", "fps-set-cap__act");
    action.append(el("span", "fps-set-cap__long"), el("span", "fps-set-cap__short"));
    key.append(el("span", "fps-set-cap__legend", legend), action);
    caps.set(code, key);
    return key;
  };
  const board = el("div", "fps-set-board");
  KEYBOARD_ROWS.forEach((row, index) => {
    const line = el("div", `fps-set-krow${index === 0 ? " fps-set-krow--f" : ""}`);
    for (const [code, legend, width] of row) line.append(cap(code, legend, width));
    if (index === KEYBOARD_ROWS.length - 1) {
      const arrows = el("div", "fps-set-arrows");
      for (const [code, legend] of ARROW_KEYS) arrows.append(cap(code, legend));
      line.append(arrows);
    }
    board.append(line);
  });
  const mouse = el("div", "fps-set-mouse-wrap"),
    picture = el("div", "fps-set-mouse"),
    mouseLabels = el("div", "fps-set-mlabels");
  for (const { code, name } of MOUSE_INPUTS) {
    const zone = input("fps-set-mzone", code);
    zone.setAttribute("aria-label", name);
    zones.set(code, zone);
    picture.append(zone);
    const label = input("fps-set-mlabel", code);
    label.append(el("span", "fps-set-mlabel__slot", name), el("span", "fps-set-mlabel__act"));
    labels.set(code, label);
    mouseLabels.append(label);
  }
  mouse.append(picture, mouseLabels);
  const refresh = () => {
    for (const [code, key] of caps) {
      const action = actionFor(code),
        fixed = FIXED_KEYS.has(code);
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
    for (const [code, zone] of zones) {
      const action = actionFor(code);
      zone.classList.toggle("is-bound", action !== null);
      zone.style.setProperty("--c", action ? groupOf(action).color : "");
      zone.setAttribute("aria-label", `${inputName(code)}: ${action?.name ?? "nothing"}`);
    }
    for (const [code, label] of labels) {
      const action = actionFor(code);
      label.classList.toggle("is-empty", action === null);
      label.style.setProperty("--c", action ? groupOf(action).color : "");
      label.querySelector(".fps-set-mlabel__act")!.textContent = action?.name ?? "Nothing";
    }
    if (!wire) {
      for (const map of [caps, zones, labels])
        for (const [code, element] of map) {
          const action = actionFor(code);
          element.classList.toggle("is-muted", !action || action.group === "other");
        }
    }
  };
  return { board, mouse, caps, zones, labels, refresh };
}
