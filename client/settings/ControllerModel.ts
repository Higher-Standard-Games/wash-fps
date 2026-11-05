import { Cvar } from "../../../../engine/core/Cvar";
import { padLabel } from "../../../../engine/input/GamepadInput";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { FPS } from "../FPSActions";

/** Versioned action namespace preserves existing keyboard overrides and account sync. */
export const controllerKey = (action: string): string => `gamepad:v1:${action}`;
export const CONTROLLER_ACTIONS = [
  { id: FPS.JUMP, name: "Jump", group: "move", button: 0 },
  { id: FPS.CROUCH, name: "Crouch / slide", group: "move", button: 1 },
  { id: FPS.SPRINT, name: "Sprint / walk", group: "move", button: 10 },
  { id: FPS.FIRE, name: "Fire", group: "fight", button: 7 },
  { id: FPS.AIM, name: "Aim", group: "fight", button: 6 },
  { id: FPS.USE, name: "Use", group: "fight", button: 2 },
  { id: FPS.RELOAD, name: "Reload", group: "fight", button: 3 },
  { id: FPS.WEAPON_PREV, name: "Previous weapon", group: "weapons", button: 4 },
  { id: FPS.WEAPON_NEXT, name: "Next weapon", group: "weapons", button: 5 },
  { id: FPS.WEAPON_1, name: "Blade", group: "weapons", button: 11 },
  { id: FPS.WEAPON_2, name: "Primary", group: "weapons", button: 14 },
  { id: FPS.WEAPON_3, name: "Secondary", group: "weapons", button: 15 },
  { id: FPS.READY, name: "Ready", group: "other", button: 12 },
  { id: FPS.JOIN_GAME, name: "Join game", group: "other", button: 13 },
  { id: FPS.SCOREBOARD, name: "Scoreboard (hold)", group: "other", button: 8 },
] as const;
export const CONTROLLER_CVARS = [
  "in_pad_yaw",
  "in_pad_pitch",
  "in_pad_curve",
  "in_pad_move_deadzone",
  "in_pad_look_deadzone",
  "in_pad_ads",
  "in_pad_invert",
  "in_pad_swap",
  "in_pad_assist",
];

export function registerControllerSettings(): void {
  for (const action of CONTROLLER_ACTIONS)
    InputSystem.getInstance().registerAction({
      id: controllerKey(action.id),
      type: "button",
      name: action.name,
      defaultBindings: [{ gamepadButton: action.button }],
    });
}
export function controllerButtons(action: string, input = InputSystem.getInstance()): number[] {
  return input
    .getBindingsForAction(controllerKey(action))
    .flatMap((binding) => (binding.gamepadButton === undefined ? [] : [binding.gamepadButton]));
}
export function controllerLabel(action: string): string {
  return controllerButtons(action).map(padLabel).join(" / ") || "Unbound";
}
export function assignControllerButton(action: string, button: number | null, input = InputSystem.getInstance()): void {
  if (button !== null && (!Number.isInteger(button) || button < 0 || button > 15 || button === 9)) return;
  if (!CONTROLLER_ACTIONS.some((item) => item.id === action)) return;
  if (button !== null)
    for (const other of CONTROLLER_ACTIONS) {
      if (other.id === action) continue;
      const existing = controllerButtons(other.id, input);
      if (existing.includes(button))
        input.rebind(
          controllerKey(other.id),
          existing.filter((value) => value !== button).map((value) => ({ gamepadButton: value })),
        );
    }
  input.rebind(controllerKey(action), button === null ? [] : [{ gamepadButton: button }]);
}
export function applyControllerPreset(preset: "standard" | "bumper", input = InputSystem.getInstance()): void {
  for (const action of CONTROLLER_ACTIONS) {
    const button =
      preset === "bumper" && action.id === FPS.JUMP
        ? 4
        : preset === "bumper" && action.id === FPS.WEAPON_PREV
          ? 0
          : action.button;
    input.rebind(controllerKey(action.id), [{ gamepadButton: button }]);
  }
}
export function controllerPreset(): "standard" | "bumper" | null {
  for (const preset of ["standard", "bumper"] as const)
    if (
      CONTROLLER_ACTIONS.every((action) => {
        const expected =
          preset === "bumper" && action.id === FPS.JUMP
            ? 4
            : preset === "bumper" && action.id === FPS.WEAPON_PREV
              ? 0
              : action.button;
        const buttons = controllerButtons(action.id);
        return buttons.length === 1 && buttons[0] === expected;
      })
    )
      return preset;
  return null;
}
export function resetController(): void {
  for (const action of CONTROLLER_ACTIONS) InputSystem.getInstance().resetBinding(controllerKey(action.id));
  for (const name of CONTROLLER_CVARS) Cvar.reset(name);
}
Cvar.register("in_pad_yaw", 240, {
  type: "float",
  min: 30,
  max: 720,
  description: "Controller horizontal turn speed (degrees per second)",
});
Cvar.register("in_pad_pitch", 180, {
  type: "float",
  min: 30,
  max: 720,
  description: "Controller vertical turn speed (degrees per second)",
});
Cvar.register("in_pad_curve", 1.7, { type: "float", min: 1, max: 3, description: "Controller look response exponent" });
Cvar.register("in_pad_move_deadzone", 0.15, {
  type: "float",
  min: 0.05,
  max: 0.4,
  description: "Controller move stick dead zone",
});
Cvar.register("in_pad_look_deadzone", 0.12, {
  type: "float",
  min: 0.05,
  max: 0.4,
  description: "Controller look stick dead zone",
});
Cvar.register("in_pad_ads", 0.5, {
  type: "float",
  min: 0.1,
  max: 1,
  description: "Controller sensitivity while aiming",
});
Cvar.register("in_pad_invert", 0, { type: "int", min: 0, max: 1, description: "Invert controller vertical look" });
Cvar.register("in_pad_swap", 0, { type: "int", min: 0, max: 1, description: "Swap controller move and look sticks" });
Cvar.register("in_pad_assist", 1, { type: "int", min: 0, max: 1, description: "Controller aim assist" });
