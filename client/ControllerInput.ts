import { CameraSystem } from "../../../engine/camera/CameraSystem";
import { Cvar } from "../../../engine/core/Cvar";
import { EventBus } from "../../../engine/core/EventBus";
import { GamepadInput, padStick } from "../../../engine/input/GamepadInput";
import { InputDevice } from "../../../engine/input/InputDevice";
import { InputSystem } from "../../../engine/input/InputSystem";
import { enterPlay, inPlay, leavePlay, PLAY_CHANGE } from "../../../engine/input/PlayCapture";
import { MapLoadingOverlay } from "../../../engine/ui/MapLoadingOverlay";
import { type UIIntent, UINavigation } from "../../../engine/ui/navigation/UINavigation";
import { CONTROLLER_MATCH_INPUT, type ControllerMatchInput } from "./ControllerEvents";
import { FPS } from "./FPSActions";
import { CONTROLLER_ACTIONS, controllerButtons, registerControllerSettings } from "./settings/ControllerModel";

interface AnalogCamera {
  setMoveAxis?(axis: { forward: number; right: number } | null): void;
  controllerLook?(yaw: number, pitch: number): void;
}

/** One application-lifetime adapter, shared by startup, lobby, and gameplay. */
export class ControllerInput {
  private readonly pad = GamepadInput.getInstance();
  private readonly nav = UINavigation.getInstance();
  private offFrame: (() => void) | null = null;
  private previousCamera: AnalogCamera | null = null;
  private direction: UIIntent | null = null;
  private repeat = 0;
  private connection: string | null = null;
  private scopeRevision = -1;
  private scoreboardHeld = false;
  private readonly onPlay = () => {
    this.pad.suppressUntilNeutral();
    this.clear();
  };
  private readonly onBlur = () => {
    this.clear();
    if (inPlay()) leavePlay();
  };

  start(): void {
    if (this.offFrame) return;
    registerControllerSettings();
    InputSystem.getInstance().loadBindingsFromStorage();
    this.offFrame = this.pad.subscribe((seconds) => {
      try {
        this.update(seconds);
      } catch (error) {
        try {
          this.clear();
        } finally {
          if (inPlay()) leavePlay();
        }
        throw error;
      }
    });
    document.addEventListener(PLAY_CHANGE, this.onPlay);
    window.addEventListener("blur", this.onBlur);
  }
  stop(): void {
    this.offFrame?.();
    this.offFrame = null;
    document.removeEventListener(PLAY_CHANGE, this.onPlay);
    window.removeEventListener("blur", this.onBlur);
    this.clear();
    this.nav.setEnabled(false);
  }

  update(seconds: number): void {
    const swap = Cvar.getBool("in_pad_swap");
    const moveDeadZone = Cvar.getNumber("in_pad_move_deadzone");
    const lookDeadZone = Cvar.getNumber("in_pad_look_deadzone");
    this.pad.setStickDeadZones(swap ? lookDeadZone : moveDeadZone, swap ? moveDeadZone : lookDeadZone);
    const enabled = InputDevice.getInstance().current === "gamepad";
    if (this.nav.enabled !== enabled) this.nav.setEnabled(enabled);
    const connected = this.pad.pad?.mapping === "standard";
    const connection = connected ? `${this.pad.pad?.index}:${this.pad.pad?.id}` : null;
    if (enabled && this.connection && this.connection !== connection && inPlay()) leavePlay();
    this.connection = connection;
    if (
      !enabled ||
      !connected ||
      document.visibilityState === "hidden" ||
      !document.hasFocus() ||
      document.getElementById("loading-screen") ||
      MapLoadingOverlay.isShowing()
    ) {
      if (enabled) this.pad.suppressUntilNeutral();
      this.clear();
      return;
    }
    const scope = this.nav.active;
    const focused = document.activeElement;
    const typing =
      focused instanceof HTMLElement &&
      (focused.isContentEditable ||
        focused instanceof HTMLTextAreaElement ||
        (focused instanceof HTMLInputElement &&
          !["range", "checkbox", "radio", "button", "submit"].includes(focused.type)));
    if (!scope && typing) {
      this.clear();
      this.pad.suppressUntilNeutral();
      return;
    }
    if (this.scopeRevision !== this.nav.revision) {
      this.pad.suppressUntilNeutral();
      this.direction = null;
      this.scopeRevision = this.nav.revision;
    }
    if (scope) {
      this.clear();
      this.nav.refresh();
      // Back wins over simultaneous Confirm/direction; one press cannot cross scopes.
      if (this.pad.pressed.has(1) || this.pad.pressed.has(9)) {
        this.nav.handle("back");
        return;
      }
      const x = this.pad.axis(0),
        y = this.pad.axis(1);
      const next: UIIntent | null = this.pad.down.has(12)
        ? "up"
        : this.pad.down.has(13)
          ? "down"
          : this.pad.down.has(14)
            ? "left"
            : this.pad.down.has(15)
              ? "right"
              : Math.max(Math.abs(x), Math.abs(y)) < (this.direction ? 0.4 : 0.6)
                ? null
                : Math.abs(x) > Math.abs(y)
                  ? x > 0
                    ? "right"
                    : "left"
                  : y > 0
                    ? "down"
                    : "up";
      this.repeat -= seconds;
      if (next && (next !== this.direction || this.repeat <= 0)) {
        this.nav.handle(next);
        this.repeat = next !== this.direction ? 0.35 : 0.1;
      }
      this.direction = next;
      if (this.scopeRevision !== this.nav.revision) return;
      if (this.pad.pressed.has(0)) this.nav.handle("confirm");
      if (this.scopeRevision !== this.nav.revision) return;
      if (Math.abs(this.pad.axis(3)) > 0.25) this.nav.scroll(this.pad.axis(3) * 650 * seconds);
      return;
    }
    if (this.pad.pressed.has(9)) {
      this.emit("menu", false, true);
      if (inPlay()) leavePlay();
      this.pad.suppressUntilNeutral();
      this.clear();
      return;
    }
    const input = InputSystem.getInstance();
    for (const action of CONTROLLER_ACTIONS) {
      const buttons = controllerButtons(action.id);
      const held = buttons.some((button) => this.pad.down.has(button));
      const pressed = buttons.some((button) => this.pad.pressed.has(button));
      this.emit(action.id, held, pressed);
      input.setVirtualAction(action.id, inPlay() && held, "gamepad");
    }
    // A starts free flight/play when no menu owns the screen.
    if (!inPlay() && this.pad.pressed.has(0)) {
      enterPlay(document.querySelector("canvas"));
      return;
    }
    const camera = CameraSystem.getInstance().getActiveController() as AnalogCamera | null;
    if (camera !== this.previousCamera) this.previousCamera?.setMoveAxis?.(null);
    this.previousCamera = camera;
    if (!inPlay()) {
      camera?.setMoveAxis?.(null);
      return;
    }
    const moveIndex = swap ? 2 : 0,
      lookIndex = swap ? 0 : 2;
    const move = padStick(this.pad.axis(moveIndex), this.pad.axis(moveIndex + 1), moveDeadZone);
    const length = Math.hypot(move.x, move.y);
    camera?.setMoveAxis?.(length ? { forward: -move.y / length, right: move.x / length } : null);
    const look = padStick(
      this.pad.axis(lookIndex),
      this.pad.axis(lookIndex + 1),
      lookDeadZone,
      Cvar.getNumber("in_pad_curve"),
    );
    const radians = (Math.PI / 180) * seconds;
    camera?.controllerLook?.(
      look.x * Cvar.getNumber("in_pad_yaw") * radians,
      look.y * Cvar.getNumber("in_pad_pitch") * radians * (Cvar.getBool("in_pad_invert") ? -1 : 1),
    );
    // Freefly uses the game's jump/crouch bindings for vertical travel too.
    input.setVirtualAction(
      FPS.FLY_UP,
      controllerButtons(FPS.JUMP).some((button) => this.pad.down.has(button)),
      "gamepad",
    );
    input.setVirtualAction(
      FPS.FLY_DOWN,
      controllerButtons(FPS.CROUCH).some((button) => this.pad.down.has(button)),
      "gamepad",
    );
  }

  private emit(action: string, held: boolean, pressed: boolean): void {
    if (action === FPS.SCOREBOARD) {
      if (held === this.scoreboardHeld) return;
      this.scoreboardHeld = held;
    }
    EventBus.emit<ControllerMatchInput>(CONTROLLER_MATCH_INPUT, { action, held, pressed });
  }
  private clear(): void {
    const input = InputSystem.getInstance();
    for (const action of CONTROLLER_ACTIONS) input.setVirtualAction(action.id, false, "gamepad");
    input.setVirtualAction(FPS.FLY_UP, false, "gamepad");
    input.setVirtualAction(FPS.FLY_DOWN, false, "gamepad");
    this.previousCamera?.setMoveAxis?.(null);
    this.previousCamera = null;
    this.emit(FPS.SCOREBOARD, false, false);
  }
}
