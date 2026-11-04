/**
 * Touch controls: the on-screen controls a phone or tablet plays with.
 *
 * A full-screen layer over the game, shown while the device is touch, touch
 * play is on and the HUD is up. Each finger owns the control it first touched
 * until it lifts:
 * - the left side (42%) is the move stick, which appears under the thumb and
 *   drives FPSController.setMoveAxis;
 * - the right side, FIRE and the FIRE + AIM seam turn the view, faster for a
 *   fast drag (the acceleration curve), and keep turning while the thumb is
 *   held at either edge of the right side (edge spin);
 * - while FIRE or the seam is held, turning the phone turns the view too
 *   (gyro, in_gyro), as big mobile shooters do;
 * - aim assist helps only drags made by real touches, never script-made
 *   events or the gyro;
 * - the buttons hold their actions through InputSystem.setVirtualAction;
 *   chat and the scoreboard, which the keyboard opens directly, go through
 *   the HUD.
 *
 * Layout and look follow docs/research/touchscreen_controls.md section 4.
 */

import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { background } from "../../../engine/core/AsyncErrors";
import { Cvar } from "../../../engine/core/Cvar";
import { EventBus } from "../../../engine/core/EventBus";
import { INPUT_DEVICE_CHANGED, InputDevice } from "../../../engine/input/InputDevice";
import { InputSystem } from "../../../engine/input/InputSystem";
import { inTouchPlay, leavePlay, PLAY_CHANGE } from "../../../engine/input/PlayCapture";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { FPS } from "./FPSActions";
import type { MoveAxis } from "./MoveStick";
import touchCSS from "./styles/TouchControls.css?raw";

/** The share of the screen's width the move side takes, from the left. */
const MOVE_SIDE = 0.42;
/** Each edge band of the look side, as a share of the screen's width. */
const EDGE_BAND = 0.07;
/** Edge spin at the very edge, in degrees per second at sensitivity 1. */
const EDGE_SPIN = 220;
/** Turning at sensitivity 1: degrees per screen height of drag. */
const LOOK_DEGREES = 130;

/**
 * How much further a drag turns for its speed, in screen heights per second:
 * slow drags turn as dragged, fast ones up to 2.8 times as far.
 */
export function lookBoost(speed: number, accel: number): number {
  return 1 + Math.min(2, Math.max(0, (speed - 0.9) / 1.4)) * 0.9 * accel;
}

/**
 * Edge spin for a thumb at `x` (a share of the screen's width): -1 to 1, 0
 * away from the look side's edges. Only a look drag spins left; FIRE sits too
 * close to the middle for that.
 */
export function edgeSpin(x: number, lookDrag: boolean): number {
  const right = 1 - EDGE_BAND;
  if (x > right) return Math.min(1, (x - right) / EDGE_BAND);
  const left = MOVE_SIDE + EDGE_BAND;
  if (lookDrag && x >= MOVE_SIDE && x < left) return -Math.min(1, (left - x) / EDGE_BAND);
  return 0;
}

/** Gyro rotation slower than this, in degrees per second, is a hand's tremor and does nothing. */
const GYRO_DEAD_ZONE = 0.8;

/**
 * The view turn (yaw right, pitch down, radians) for the phone's rotation
 * rate over `seconds`: the screen turning one degree turns the view one
 * degree. `beta` and `gamma` turn about the device's own x and y axes, which in
 * landscape run up the screen and across it; `angle` is the screen's
 * orientation angle (90 or 270), and portrait turns nothing.
 */
export function gyroTurn(beta: number, gamma: number, angle: number, seconds: number): [number, number] {
  const sign = angle === 90 ? 1 : angle === 270 || angle === -90 ? -1 : 0;
  if (sign === 0) return [0, 0];
  const live = (rate: number) => (Math.abs(rate) < GYRO_DEAD_ZONE ? 0 : rate);
  const toRadians = (Math.PI / 180) * seconds;
  return [-sign * live(beta) * toRadians, sign * live(gamma) * toRadians];
}

/** Ask for the gyro where the browser wants permission first (an iPhone); quiet otherwise. */
async function askForMotion(): Promise<void> {
  const motion = globalThis.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
  try {
    await motion?.requestPermission?.();
  } catch {
    // Refused or not offered: shooting turns with the thumbs alone
  }
}

/** What the HUD opens for the touch controls. */
export interface TouchHud {
  openChat(): void;
  showScoreboard(): void;
  hideScoreboard(): void;
}

/** The parts of the FPS camera controller the touch controls drive. */
interface TouchDriven {
  readonly type: string;
  currentWeaponSlot: number;
  setMoveAxis(axis: MoveAxis | null): void;
  touchLook(dx: number, dy: number, sensitivity: number, assist: boolean): void;
}

type Control =
  | "move"
  | "look"
  | "fire"
  | "seam"
  | "aim"
  | "jump"
  | "crouch"
  | "reload"
  | "prev"
  | "next"
  | "blade"
  | "menu"
  | "score"
  | "chat"
  | "ready"
  | "use";

interface Finger {
  control: Control;
  el: HTMLElement | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  t: number;
  dragged: boolean;
  /** Actions this finger holds, released when it lifts. */
  holds: string[];
  /** A real touch, not a script-made event: only real touches get aim assist. */
  trusted: boolean;
  /** For the seam: whether aim was toggled on before the thumb came down. */
  aimBefore?: boolean;
}

const ICONS = {
  menu: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  score: '<path d="M5 6h3M11 6h8M5 12h3M11 12h8M5 18h3M11 18h8"/>',
  chat: '<path d="M5 5h14v10H10l-4 4v-4H5z"/>',
  reload: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4v4h-4"/>',
  aim: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  fire: '<circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.2 2.2M16.2 16.2l2.2 2.2M5.6 18.4l2.2-2.2M16.2 7.8l2.2-2.2"/>',
  crouch: '<path d="M6 8l6 6 6-6"/><path d="M5 19h14"/>',
  jump: '<path d="M6 15l6-6 6 6"/><path d="M6 20l6-6 6 6" opacity=".5"/>',
  prev: '<path d="M12 6l-6 6 6 6M19 6l-6 6 6 6"/>',
  next: '<path d="M5 6l6 6-6 6M12 6l6 6-6 6"/>',
};

export class TouchControls {
  private readonly root: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly aimButton: HTMLElement;
  private readonly aimCap: HTMLElement;
  private readonly readyButton: HTMLElement;
  private readonly useButton: HTMLElement;
  private readonly edgeLeft: HTMLElement;
  private readonly edgeRight: HTMLElement;
  private readonly fingers = new Map<number, Finger>();
  private readonly listeners = new AbortController();
  private readonly offDevice: () => void;
  private hudHidden = false;
  private visible = false;
  private aimToggled = false;
  private lastGunSlot = 1;
  private frame = 0;
  private lastFrame = 0;
  /** The gyro's latest rotation rate (degrees per second), while the controls are up. */
  private motion: { beta: number; gamma: number } | null = null;
  private motionAsked = false;
  private readonly onMotion = (e: DeviceMotionEvent): void => {
    const rate = e.rotationRate;
    this.motion = rate ? { beta: rate.beta ?? 0, gamma: rate.gamma ?? 0 } : null;
  };

  constructor(private readonly hud: TouchHud) {
    UIStyles.injectCSS("touch-controls", touchCSS);
    this.root = document.createElement("div");
    this.root.className = "touch-controls";
    this.root.hidden = true;
    this.inner = element("div", "touch-controls__inner");
    this.root.append(this.inner);

    this.inner.append(
      element("div", "touch-controls__label touch-controls__label--move", "Move"),
      element("div", "touch-controls__label touch-controls__label--look", "Look"),
    );
    this.edgeLeft = element("div", "touch-controls__edge touch-controls__edge--left");
    this.edgeRight = element("div", "touch-controls__edge touch-controls__edge--right");
    const ghost = element("div", "touch-controls__stick touch-controls__stick--ghost");
    ghost.append(element("div", "touch-controls__knob"));
    this.stick = element("div", "touch-controls__stick touch-controls__stick--live");
    this.knob = element("div", "touch-controls__knob");
    this.stick.append(this.knob);
    this.inner.append(this.edgeLeft, this.edgeRight, ghost, this.stick);

    this.inner.append(
      button("menu", "touch-btn--small touch-btn--menu", ICONS.menu, "Menu"),
      button("score", "touch-btn--small touch-btn--score", ICONS.score, "Scoreboard"),
      button("chat", "touch-btn--small touch-btn--chat", ICONS.chat, "Chat"),
      button("prev", "touch-btn--weapon touch-btn--prev", ICONS.prev, "Previous weapon"),
      button("next", "touch-btn--weapon touch-btn--next", ICONS.next, "Next weapon"),
      button("blade", "touch-btn--blade", "", "Blade", "BL"),
      button("reload", "touch-btn--reload", ICONS.reload, "Reload", "", "RELOAD"),
      button("fire", "touch-btn--fire", ICONS.fire, "Fire"),
      button("seam", "touch-btn--seam", "", "Fire and aim"),
      button("crouch", "touch-btn--crouch", ICONS.crouch, "Crouch", "", "CROUCH"),
      button("jump", "touch-btn--jump", ICONS.jump, "Jump", "", "JUMP"),
    );
    this.readyButton = button("ready", "touch-btn--ready", "", "Ready", "READY");
    this.useButton = button("use", "touch-btn--use", "", "Pick up", "USE");
    this.aimButton = button("aim", "touch-btn--aim", ICONS.aim, "Aim", "", "AIM");
    this.aimCap = this.aimButton.querySelector(".touch-btn__cap") as HTMLElement;
    this.inner.append(this.aimButton, this.readyButton, this.useButton);
    // Where the browser cannot lock landscape (an iPhone), portrait asks for it
    this.root.append(element("div", "touch-controls__rotate", "Turn your device sideways to play"));
    document.body.append(this.root);

    const signal = this.listeners.signal;
    this.root.addEventListener("pointerdown", (e) => this.down(e), { signal });
    this.root.addEventListener("pointermove", (e) => this.move(e), { signal });
    this.root.addEventListener("pointerup", (e) => this.up(e), { signal });
    this.root.addEventListener("pointercancel", (e) => this.up(e), { signal });
    this.root.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    // No click may follow a touch here: once the menu button hides the controls,
    // it would land on the game and start touch play again
    const noClick = (e: TouchEvent) => e.preventDefault();
    this.root.addEventListener("touchstart", noClick, { signal, passive: false });
    this.root.addEventListener("touchend", noClick, { signal, passive: false });
    document.addEventListener(PLAY_CHANGE, () => this.refresh(), { signal });
    this.offDevice = EventBus.on(INPUT_DEVICE_CHANGED, () => this.refresh());
    this.refresh();
  }

  /** The HUD is hidden (post-game, a demo's fly-by): the controls go with it. */
  setHudHidden(hidden: boolean): void {
    this.hudHidden = hidden;
    this.refresh();
  }

  destroy(): void {
    this.setVisible(false);
    this.listeners.abort();
    this.offDevice();
    this.root.remove();
    UIStyles.removeCSS("touch-controls");
  }

  private refresh(): void {
    this.setVisible(InputDevice.getInstance().current === "touch" && inTouchPlay() && !this.hudHidden);
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.root.hidden = !visible;
    // The HUD's bottom row makes room for the buttons (TouchControls.css)
    document.body.classList.toggle("touch-play", visible);
    if (visible) {
      this.lastFrame = performance.now();
      this.frame = requestAnimationFrame((now) => this.tick(now));
      window.addEventListener("devicemotion", this.onMotion);
      return;
    }
    cancelAnimationFrame(this.frame);
    window.removeEventListener("devicemotion", this.onMotion);
    this.motion = null;
    for (const id of [...this.fingers.keys()]) this.release(id);
    this.setAimToggled(false);
  }

  private controller(): TouchDriven | null {
    const controller = CameraSystem.getInstance().getActiveController() as unknown as TouchDriven | null;
    return controller?.type === "fps" ? controller : null;
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    if (window.matchMedia?.("(orientation: portrait)").matches) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-control]");
    const rect = this.inner.getBoundingClientRect();
    const control =
      (target?.dataset.control as Control | undefined) ??
      ((e.clientX - rect.left) / rect.width < MOVE_SIDE ? "move" : "look");
    const finger: Finger = {
      control,
      el: target,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      dragged: false,
      holds: [],
      trusted: e.isTrusted,
    };
    this.fingers.set(e.pointerId, finger);
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {}
    target?.classList.add("down");
    this.press(finger);
  }

  private press(finger: Finger): void {
    const hold = (action: string) => {
      InputSystem.getInstance().setVirtualAction(action, true);
      finger.holds.push(action);
    };
    const blade = this.controller()?.currentWeaponSlot === 0;
    switch (finger.control) {
      case "move": {
        const rect = this.inner.getBoundingClientRect();
        this.stick.style.left = `${finger.x - rect.left}px`;
        this.stick.style.top = `${finger.y - rect.top}px`;
        this.knob.style.transform = "";
        this.root.classList.add("touch-controls--moving");
        this.inner.querySelector(".touch-controls__label--move")?.classList.add("used");
        break;
      }
      case "look":
        this.inner.querySelector(".touch-controls__label--look")?.classList.add("used");
        break;
      case "fire":
        hold(FPS.FIRE);
        break;
      case "seam":
        // Both while the thumb stays; aim goes back to how it was on release
        finger.aimBefore = this.aimToggled;
        hold(FPS.FIRE);
        if (!blade) hold(FPS.AIM);
        this.inner.querySelector(".touch-btn--fire")?.classList.add("down");
        this.aimButton.classList.add("down");
        break;
      case "aim":
        // The blade's alternate fire charges while held; other weapons toggle on tap
        if (blade) hold(FPS.AIM);
        break;
      case "jump":
        hold(FPS.JUMP);
        break;
      case "crouch":
        hold(FPS.CROUCH);
        break;
      case "reload":
        hold(FPS.RELOAD);
        break;
      case "prev":
        this.setAimToggled(false);
        hold(FPS.WEAPON_PREV);
        break;
      case "next":
        this.setAimToggled(false);
        hold(FPS.WEAPON_NEXT);
        break;
      case "blade": {
        // The blade; pressed again, the last gun
        this.setAimToggled(false);
        const slot = this.controller()?.currentWeaponSlot ?? 0;
        if (slot !== 0) this.lastGunSlot = slot;
        hold(slot === 0 ? `fps_weapon_${this.lastGunSlot + 1}` : FPS.WEAPON_1);
        break;
      }
      case "score":
        this.hud.showScoreboard();
        break;
      case "ready":
        hold(FPS.READY);
        break;
      case "use":
        hold(FPS.USE);
        break;
    }
  }

  private move(e: PointerEvent): void {
    const finger = this.fingers.get(e.pointerId);
    if (!finger) return;
    const now = performance.now();
    const dx = e.clientX - finger.x;
    const dy = e.clientY - finger.y;
    const dt = Math.max(1, now - finger.t);
    finger.x = e.clientX;
    finger.y = e.clientY;
    finger.t = now;
    if (Math.hypot(e.clientX - finger.startX, e.clientY - finger.startY) > 6) finger.dragged = true;

    if (finger.control === "move") {
      const radius = this.inner.clientHeight * 0.11;
      let ox = e.clientX - finger.startX;
      let oy = e.clientY - finger.startY;
      const length = Math.hypot(ox, oy);
      if (length > radius) {
        ox *= radius / length;
        oy *= radius / length;
      }
      this.knob.style.transform = `translate(${ox}px, ${oy}px)`;
      this.controller()?.setMoveAxis({ forward: -oy / radius, right: ox / radius });
    } else if (this.turns(finger.control)) {
      const height = Math.max(1, this.inner.clientHeight);
      const speed = Math.hypot(dx, dy) / height / (dt / 1000);
      const boost = lookBoost(speed, Cvar.getNumber("in_touchaccel") ?? 1);
      this.controller()?.touchLook(dx, dy, this.lookSensitivity() * boost, finger.trusted && e.isTrusted);
    }
  }

  private up(e: PointerEvent): void {
    const finger = this.fingers.get(e.pointerId);
    if (!finger) return;
    // An iPhone asks before sharing the gyro, and only from a tap: the first one
    if (e.isTrusted && !this.motionAsked) {
      this.motionAsked = true;
      background(askForMotion(), "TouchControls");
    }
    if (!finger.dragged) {
      // Taps
      if (finger.control === "aim" && finger.holds.length === 0) this.setAimToggled(!this.aimToggled);
      else if (finger.control === "menu") leavePlay();
      else if (finger.control === "chat") this.hud.openChat();
    }
    this.release(e.pointerId);
  }

  private release(pointerId: number): void {
    const finger = this.fingers.get(pointerId);
    if (!finger) return;
    this.fingers.delete(pointerId);
    const input = InputSystem.getInstance();
    for (const action of finger.holds) input.setVirtualAction(action, false);
    finger.el?.classList.remove("down");
    if (finger.control === "move") {
      this.root.classList.remove("touch-controls--moving");
      this.controller()?.setMoveAxis(null);
    } else if (finger.control === "score") {
      this.hud.hideScoreboard();
    } else if (finger.control === "seam") {
      this.inner.querySelector(".touch-btn--fire")?.classList.remove("down");
      this.aimButton.classList.remove("down");
      this.setAimToggled(Boolean(finger.aimBefore));
    }
  }

  private setAimToggled(on: boolean): void {
    this.aimToggled = on;
    InputSystem.getInstance().setVirtualAction(FPS.AIM, on);
    this.aimButton.classList.toggle("on", on);
  }

  private turns(control: Control): boolean {
    return control === "look" || control === "fire" || control === "seam";
  }

  private placeUseButton(inner: DOMRect): void {
    const prompt = document.getElementById("pickup-hud-prompt");
    const showing = !!prompt && prompt.style.display !== "none" && prompt.style.opacity !== "0";
    this.useButton.classList.toggle("shown", showing);
    if (!showing || !prompt) return;
    const below = prompt.getBoundingClientRect().bottom - inner.top + inner.height * 0.02;
    const top = `${Math.round(below)}px`;
    if (this.useButton.style.top !== top) this.useButton.style.top = top;
  }

  /** Radians per screen pixel of drag at sensitivity 1. */
  private lookSensitivity(): number {
    const height = Math.max(1, this.inner.clientHeight);
    return ((LOOK_DEGREES * Math.PI) / 180 / height) * (Cvar.getNumber("in_touchsens") ?? 1);
  }

  // Edge spin, the AIM label for the weapon in hand, READY while warmup asks
  // for it, and USE under the pick-up prompt while there is one
  private tick(now: number): void {
    if (!this.visible) return;
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const rect = this.inner.getBoundingClientRect();
    let spin = 0;
    let spinTrusted = false;
    let shooting = false;
    for (const finger of this.fingers.values()) {
      if (finger.control === "fire" || finger.control === "seam") shooting = true;
      if (!finger.dragged || !this.turns(finger.control)) continue;
      const rate = edgeSpin((finger.x - rect.left) / Math.max(1, rect.width), finger.control === "look");
      if (rate !== 0) {
        spin = rate;
        spinTrusted = finger.trusted;
      }
    }
    this.edgeLeft.classList.toggle("on", spin < 0);
    this.edgeRight.classList.toggle("on", spin > 0);
    const controller = this.controller();
    if (spin !== 0 && controller) {
      const radians = ((spin * EDGE_SPIN * Math.PI) / 180) * dt * (Cvar.getNumber("in_touchsens") ?? 1);
      controller.touchLook(radians, 0, 1, spinTrusted);
    }
    const motion = this.motion;
    if (shooting && motion && controller && (Cvar.getNumber("in_gyro") ?? 1) > 0) {
      const angle = screen.orientation?.angle ?? 90;
      const [yaw, pitch] = gyroTurn(motion.beta, motion.gamma, angle, dt * (Cvar.getNumber("in_gyrosens") ?? 1));
      if (yaw !== 0 || pitch !== 0) controller.touchLook(yaw, pitch, 1, false);
    }
    const blade = controller?.currentWeaponSlot === 0;
    const caption = blade ? "CHARGE" : "AIM";
    if (this.aimCap.textContent !== caption) this.aimCap.textContent = caption;
    const asking = !!document.querySelector(".fps-ready-bar:not(.hidden):not(.fps-ready-bar--spectating)");
    this.readyButton.classList.toggle("shown", asking);
    this.placeUseButton(rect);
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }
}

function element(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(
  control: Control,
  className: string,
  icon: string,
  label: string,
  text = "",
  caption = "",
): HTMLElement {
  const node = element("div", `touch-btn ${className}`, text);
  node.dataset.control = control;
  node.setAttribute("aria-label", label);
  if (icon) node.insertAdjacentHTML("beforeend", `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`);
  if (caption) node.append(element("span", "touch-btn__cap", caption));
  return node;
}

Cvar.register("in_touchsens", 1, {
  type: "float",
  min: 0.2,
  max: 4,
  description: "Touch look sensitivity: 1 turns 130 degrees per screen height of drag",
});

Cvar.register("in_gyro", 1, {
  type: "int",
  min: 0,
  max: 1,
  description: "Gyro aim while shooting on a touch screen: turning the phone turns the view (0 = off)",
});

Cvar.register("in_gyrosens", 1, {
  type: "float",
  min: 0.2,
  max: 3,
  description: "Gyro aim speed: 1 turns the view as far as the phone turns",
});

Cvar.register("in_touchaccel", 1, {
  type: "float",
  min: 0,
  max: 2,
  description: "Touch look acceleration: how much further fast drags turn (0 = none)",
});
