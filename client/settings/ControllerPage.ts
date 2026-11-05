import { Cvar } from "../../../../engine/core/Cvar";
import { EventBus } from "../../../../engine/core/EventBus";
import { GamepadInput, padLabel } from "../../../../engine/input/GamepadInput";
import { INPUT_DEVICE_CHANGED, InputDevice } from "../../../../engine/input/InputDevice";
import { leavePlay } from "../../../../engine/input/PlayCapture";
import { UINavigation } from "../../../../engine/ui/navigation/UINavigation";
import { UIStyles } from "../../../../engine/ui/UIStyles";
import {
  applyControllerPreset,
  assignControllerButton,
  CONTROLLER_ACTIONS,
  controllerButtons,
  controllerLabel,
  controllerPreset,
  registerControllerSettings,
} from "./ControllerModel";
import css from "./ControllerPage.css?raw";
import type { ControlsHost } from "./ControlsPage";
import { button, card, el, formatPercent, seg, slider } from "./SettingsFields";
import { ACTION_GROUPS } from "./SettingsModel";

const POSITIONS = [
  [77, 53],
  [85, 41],
  [69, 41],
  [77, 29],
  [23, 12],
  [77, 12],
  [23, 2],
  [77, 2],
  [42, 36],
  [58, 36],
  [26, 40],
  [60, 68],
  [39, 61],
  [39, 81],
  [32, 71],
  [46, 71],
];

export class ControllerPage {
  readonly root = el("div", "fps-set-controller");
  private readonly status = el("p", "fps-pad-status");
  private readonly live = el("p", "fps-pad-live");
  private readonly preset = el("p", "fps-pad-preset");
  private readonly rows = new Map<string, HTMLButtonElement>();
  private readonly caps = new Map<number, HTMLButtonElement>();
  private readonly picker = el("div", "fps-set-pop fps-set-pop__card fps-pad-pop");
  private offScope: (() => void) | null = null;
  private readonly offFrame: () => void;
  private readonly offDevice: () => void;
  private listening: string | null = null;
  private lastPadList = "";
  private readonly devices = el("div", "fps-pad-devices");
  private readonly onBlur = () => this.deactivate();
  private readonly onKey = (event: KeyboardEvent) => {
    if (!this.picker.hidden && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.deactivate();
    }
  };

  constructor(private readonly host: ControlsHost) {
    registerControllerSettings();
    UIStyles.injectCSS("fps-controller-settings", css);
    const connection = card("Controller", "Press a controller button on the loading screen to choose controller mode.");
    this.status.setAttribute("role", "status");
    connection.append(this.status, this.devices);
    const modes = el("div", "fps-pad-mode");
    for (const [device, label] of [
      ["gamepad", "Use controller"],
      ["keyboard_mouse", "Use keyboard / mouse"],
      ["touch", "Use touch"],
    ] as const) {
      const key = button("fps-set-seg__btn", label);
      if (device === "touch") key.hidden = !InputDevice.getInstance().touchCapable;
      key.addEventListener("click", () => {
        leavePlay();
        InputDevice.getInstance().select(device);
        GamepadInput.getInstance().suppressUntilNeutral();
        host.changed();
      });
      host.addRefresh(() => key.setAttribute("aria-pressed", String(InputDevice.getInstance().current === device)));
      modes.append(key);
    }
    connection.append(modes);
    const presets = card("Layout", "Menu navigation always uses A to select, B to go back, and Menu to pause.");
    seg(host, presets, {
      name: "Preset",
      choices: [
        { value: "standard" as const, label: "Standard" },
        { value: "bumper" as const, label: "Bumper jump" },
      ],
      get: controllerPreset,
      set: applyControllerPreset,
    });
    presets.append(this.preset);
    const diagramCard = card(
      "Your controller",
      "Select a button to choose its action. Focus an action to highlight its button.",
    );
    const diagram = el("div", "fps-pad-diagram");
    diagram.innerHTML =
      '<svg viewBox="0 0 480 310" aria-hidden="true"><path d="M110 48 Q240 10 370 48 Q415 62 446 235 Q452 293 407 281 L330 213 Q240 240 150 213 L73 281 Q28 293 34 235 Q65 62 110 48 Z"/><circle cx="125" cy="124" r="36"/><circle cx="288" cy="211" r="33"/><path d="M165 188 h43 v43 h-43 Z"/></svg>';
    POSITIONS.forEach(([x, y], index) => {
      const cap = button("fps-pad-cap", index >= 12 ? ["↑", "↓", "←", "→"][index - 12] : padLabel(index));
      cap.style.left = `${x}%`;
      cap.style.top = `${y}%`;
      cap.dataset.navId = `pad-${index}`;
      cap.addEventListener("click", () => this.chooseAction(index));
      cap.addEventListener("focus", () => this.highlightButton(index));
      cap.addEventListener("mouseenter", () => this.highlightButton(index));
      diagram.append(cap);
      this.caps.set(index, cap);
    });
    diagramCard.append(
      diagram,
      this.live,
      el("small", "", "Sticks: move / look · LS: walk with Always run · Menu: pause / resume"),
    );
    const actions = card(
      "What each button does",
      "Select an action, release the controls, then press its new button. Menu cancels.",
    );
    const groups = el("div", "fps-set-acts");
    for (const group of ACTION_GROUPS) {
      const column = el("div", "fps-set-act-group");
      column.style.setProperty("--c", group.color);
      column.append(el("h3", "fps-set-act-group__title", group.name));
      for (const action of CONTROLLER_ACTIONS.filter((item) => item.group === group.id)) {
        const line = el("div", "fps-pad-action");
        const row = button("fps-set-act");
        row.dataset.navId = `pad-action-${action.id}`;
        row.addEventListener("click", () => this.capture(action.id));
        row.addEventListener("focus", () => this.highlightAction(action.id));
        row.addEventListener("mouseenter", () => this.highlightAction(action.id));
        this.rows.set(action.id, row);
        const clear = button("fps-pad-clear", "×");
        clear.setAttribute("aria-label", `Clear controller binding for ${action.name}`);
        clear.addEventListener("click", () => {
          assignControllerButton(action.id, null);
          host.changed();
        });
        line.append(row, clear);
        column.append(line);
      }
      groups.append(column);
    }
    actions.append(groups);
    const tuning = card("Stick feel", "Movement uses full speed outside the dead zone. Hold Sprint / walk to walk.");
    const feel = el("div", "fps-set-stack fps-pad-feel");
    tuning.append(feel);
    for (const [name, cvar, min, max, step] of [
      ["Horizontal turn speed (°/s)", "in_pad_yaw", 30, 720, 10],
      ["Vertical turn speed (°/s)", "in_pad_pitch", 30, 720, 10],
      ["Look response curve", "in_pad_curve", 1, 3, 0.1],
      ["Move dead zone", "in_pad_move_deadzone", 0.05, 0.4, 0.01],
      ["Look dead zone", "in_pad_look_deadzone", 0.05, 0.4, 0.01],
      ["While aiming", "in_pad_ads", 0.1, 1, 0.05],
    ] as const)
      slider(host, feel, {
        name,
        min,
        max,
        step,
        get: () => Cvar.getNumber(cvar),
        set: (value) => Cvar.set(cvar, value),
        format: cvar.includes("deadzone") || cvar === "in_pad_ads" ? formatPercent : undefined,
      });
    for (const [name, cvar] of [
      ["Invert vertical look", "in_pad_invert"],
      ["Swap move and look sticks", "in_pad_swap"],
      ["Aim assist", "in_pad_assist"],
    ] as const) {
      seg(host, feel, {
        name,
        choices: [
          { value: 0, label: "Off" },
          { value: 1, label: "On" },
        ],
        get: () => Cvar.getNumber(cvar),
        set: (value) => {
          Cvar.set(cvar, value);
        },
      });
    }
    this.root.append(connection, presets, diagramCard, actions, tuning);
    this.picker.hidden = true;
    this.picker.setAttribute("role", "dialog");
    this.picker.setAttribute("aria-label", "Controller binding");
    document.body.append(this.picker);
    this.offFrame = GamepadInput.getInstance().subscribe(() => this.tick());
    this.offDevice = EventBus.on(INPUT_DEVICE_CHANGED, () => host.changed());
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("keydown", this.onKey, true);
    host.addRefresh(() => this.render());
    this.render();
  }

  deactivate(): void {
    this.listening = null;
    this.picker.hidden = true;
    this.offScope?.();
    this.offScope = null;
  }
  destroy(): void {
    this.deactivate();
    this.offFrame();
    this.offDevice();
    this.picker.remove();
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("keydown", this.onKey, true);
  }

  private showPicker(): void {
    this.deactivate();
    this.picker.replaceChildren();
    this.picker.hidden = false;
    this.offScope = UINavigation.getInstance().push({
      root: this.picker,
      back: () => this.deactivate(),
      intent: () => this.listening !== null,
    });
  }
  private capture(action: string): void {
    this.showPicker();
    this.listening = action;
    this.picker.append(
      el("h3", "", "Release controls, then press a button"),
      el("p", "", "Press Menu to cancel. B can be assigned."),
    );
    const cancel = button("fps-set-seg__btn", "Cancel");
    cancel.addEventListener("click", () => this.deactivate());
    this.picker.append(cancel);
    GamepadInput.getInstance().suppressUntilNeutral();
  }
  private chooseAction(index: number): void {
    if (index === 9) {
      this.host.toast("Menu is reserved for pause and recovery.");
      return;
    }
    this.showPicker();
    this.picker.append(el("h3", "", `${padLabel(index)}: choose an action`));
    for (const action of CONTROLLER_ACTIONS) {
      const key = button("fps-set-seg__btn", action.name);
      key.addEventListener("click", () => this.assign(action.id, index));
      this.picker.append(key);
    }
    const cancel = button("fps-set-seg__btn", "Cancel");
    cancel.addEventListener("click", () => this.deactivate());
    this.picker.append(cancel);
  }
  private assign(action: string, index: number): void {
    const conflict = CONTROLLER_ACTIONS.find(
      (item) => item.id !== action && controllerButtons(item.id).includes(index),
    );
    if (conflict) {
      this.showPicker();
      this.picker.append(el("h3", "", `${padLabel(index)} already does ${conflict.name}`));
      const replace = button("fps-set-seg__btn", "Replace binding");
      replace.addEventListener("click", () => this.commit(action, index));
      const cancel = button("fps-set-seg__btn", "Cancel");
      cancel.addEventListener("click", () => this.deactivate());
      this.picker.append(cancel, replace);
    } else this.commit(action, index);
  }
  private commit(action: string, index: number): void {
    assignControllerButton(action, index);
    this.deactivate();
    GamepadInput.getInstance().suppressUntilNeutral();
    this.host.changed();
  }
  private tick(): void {
    if (this.root.closest("[hidden]") || !this.root.isConnected || !this.root.getClientRects().length) return;
    const pad = GamepadInput.getInstance();
    this.status.textContent = !pad.available
      ? "Gamepad API unavailable. Use HTTPS or localhost in a supported browser."
      : !pad.pad
        ? "Press a controller button to detect it. A connection alone does not enable controller mode."
        : pad.pad.mapping !== "standard"
          ? `${pad.pad.id}: unsupported mapping`
          : `${pad.pad.id} · ${InputDevice.getInstance().current === "gamepad" ? "Controller mode" : "Available — choose Use controller to enable"}`;
    const list = pad.pads.map((device) => `${device.index}:${device.id}`).join("|");
    if (list !== this.lastPadList) {
      this.lastPadList = list;
      this.devices.replaceChildren();
      for (const device of pad.pads) {
        const key = button("fps-set-seg__btn", device.id);
        key.disabled = device.mapping !== "standard";
        key.addEventListener("click", () => pad.select(device.index));
        this.devices.append(key);
      }
    }
    this.live.textContent = pad.pad
      ? `Left ${pad.pad.axes
          .slice(0, 2)
          .map((value) => value.toFixed(2))
          .join(", ")} · Right ${pad.pad.axes
          .slice(2, 4)
          .map((value) => value.toFixed(2))
          .join(
            ", ",
          )} · LT ${(pad.pad.buttons[6]?.value ?? 0).toFixed(2)} · RT ${(pad.pad.buttons[7]?.value ?? 0).toFixed(2)}`
      : "";
    for (const [index, cap] of this.caps)
      cap.classList.toggle("is-pressed", (pad.pad?.buttons[index]?.value ?? 0) > 0.3);
    if (this.listening) {
      if (!pad.pad) {
        this.deactivate();
        return;
      }
      if (pad.pressed.has(9)) this.deactivate();
      else {
        const index = [...pad.pressed].find((value) => value < 16);
        if (index !== undefined) this.assign(this.listening, index);
      }
    }
  }
  private render(): void {
    this.preset.textContent = controllerPreset() ? "Edit any action below to make a custom layout." : "Custom layout";
    for (const action of CONTROLLER_ACTIONS) {
      const row = this.rows.get(action.id);
      if (row) {
        row.textContent = `${action.name} · ${controllerLabel(action.id)}`;
        row.setAttribute("aria-label", `${action.name}: ${controllerLabel(action.id)}`);
      }
    }
    for (const [index, cap] of this.caps) {
      const action = CONTROLLER_ACTIONS.find((item) => controllerButtons(item.id).includes(index));
      cap.title = `${padLabel(index)}: ${index === 9 ? "Menu" : (action?.name ?? "Unbound")}`;
      cap.setAttribute("aria-label", cap.title);
      cap.style.setProperty("--c", ACTION_GROUPS.find((group) => group.id === action?.group)?.color ?? "#c9c5b9");
    }
  }
  private highlightAction(action: string): void {
    const buttons = controllerButtons(action);
    for (const [index, cap] of this.caps) cap.classList.toggle("is-focus", buttons.includes(index));
  }
  private highlightButton(index: number): void {
    for (const [id, row] of this.rows) row.classList.toggle("is-hl", controllerButtons(id).includes(index));
  }
}
