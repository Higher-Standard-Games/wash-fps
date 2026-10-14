/**
 * FPSActions - Central FPS key binding definitions
 *
 * All FPS action IDs, default bindings, and context definitions.
 * Registers into the engine's InputSystem on game init.
 *
 * Usage:
 *   import { FPS, registerFPSActions } from './FPSActions';
 *   registerFPSActions();  // call once at game init
 *
 *   // In update loop:
 *   const input = InputSystem.getInstance();
 *   if (input.isActive(FPS.MOVE_FORWARD)) { ... }
 *   if (input.wasPressed(FPS.SCOREBOARD)) { ... }
 */

import { InputSystem } from "../../../engine/input/InputSystem";
import type { ActionDefinition } from "../../../engine/input/InputTypes";

// ==================== Action ID Constants ====================

/** All FPS action IDs as typed string constants */
export const FPS = {
  // --- Movement ---
  MOVE_FORWARD: "fps_move_forward",
  MOVE_BACKWARD: "fps_move_backward",
  MOVE_LEFT: "fps_move_left",
  MOVE_RIGHT: "fps_move_right",
  JUMP: "fps_jump",
  CROUCH: "fps_crouch",
  SPRINT: "fps_sprint",
  FLY_UP: "fps_fly_up",
  FLY_DOWN: "fps_fly_down",

  // --- Combat ---
  FIRE: "fps_fire",
  AIM: "fps_aim",
  RELOAD: "fps_reload",
  USE: "fps_use",

  // --- Weapons ---
  WEAPON_1: "fps_weapon_1",
  WEAPON_2: "fps_weapon_2",
  WEAPON_3: "fps_weapon_3",
  WEAPON_4: "fps_weapon_4",
  WEAPON_5: "fps_weapon_5",
  WEAPON_6: "fps_weapon_6",
  WEAPON_7: "fps_weapon_7",
  WEAPON_8: "fps_weapon_8",
  WEAPON_9: "fps_weapon_9",
  WEAPON_NEXT: "fps_weapon_next",
  WEAPON_PREV: "fps_weapon_prev",

  // --- HUD / UI ---
  SCOREBOARD: "fps_scoreboard",
  CHAT: "fps_chat",
  TEAM_CHAT: "fps_team_chat",
  READY: "fps_ready",
  JOIN_GAME: "fps_join_game",
  CONSOLE: "fps_console",
} as const;

/** Type for any FPS action ID */
export type FPSActionId = (typeof FPS)[keyof typeof FPS];

// ==================== Default Bindings ====================

/** Default key/mouse bindings for all FPS actions */
const FPS_ACTION_DEFS: ActionDefinition[] = [
  // --- Movement ---
  { id: FPS.MOVE_FORWARD, type: "button", name: "Move Forward", defaultBindings: [{ key: "KeyW" }] },
  { id: FPS.MOVE_BACKWARD, type: "button", name: "Move Backward", defaultBindings: [{ key: "KeyS" }] },
  { id: FPS.MOVE_LEFT, type: "button", name: "Strafe Left", defaultBindings: [{ key: "KeyA" }] },
  { id: FPS.MOVE_RIGHT, type: "button", name: "Strafe Right", defaultBindings: [{ key: "KeyD" }] },
  { id: FPS.JUMP, type: "button", name: "Jump", defaultBindings: [{ key: "Space" }] },
  {
    id: FPS.CROUCH,
    type: "button",
    name: "Crouch",
    defaultBindings: [{ mouseButton: "middle" }, { key: "KeyC" }, { key: "ControlLeft" }, { key: "ControlRight" }],
  },
  { id: FPS.SPRINT, type: "button", name: "Sprint", defaultBindings: [{ key: "ShiftLeft" }, { key: "ShiftRight" }] },
  { id: FPS.FLY_UP, type: "button", name: "Fly Up (Spectator)", defaultBindings: [{ key: "Space" }] },
  {
    id: FPS.FLY_DOWN,
    type: "button",
    name: "Fly Down (Spectator)",
    defaultBindings: [{ key: "ShiftLeft" }, { key: "ShiftRight" }],
  },

  // --- Combat ---
  { id: FPS.FIRE, type: "button", name: "Fire", defaultBindings: [{ mouseButton: "left" }] },
  { id: FPS.AIM, type: "button", name: "Aim / ADS", defaultBindings: [{ mouseButton: "right" }] },
  { id: FPS.RELOAD, type: "button", name: "Reload", defaultBindings: [{ key: "KeyR" }] },
  { id: FPS.USE, type: "button", name: "Use / Interact", defaultBindings: [{ key: "KeyF" }] },

  // --- Weapons ---
  {
    id: FPS.WEAPON_1,
    type: "button",
    name: "Weapon 1 (Blade)",
    defaultBindings: [{ key: "Digit1" }, { key: "KeyQ" }],
  },
  { id: FPS.WEAPON_2, type: "button", name: "Weapon 2", defaultBindings: [{ key: "Digit2" }] },
  { id: FPS.WEAPON_3, type: "button", name: "Weapon 3", defaultBindings: [{ key: "Digit3" }] },
  { id: FPS.WEAPON_4, type: "button", name: "Weapon 4", defaultBindings: [{ key: "Digit4" }] },
  { id: FPS.WEAPON_5, type: "button", name: "Weapon 5", defaultBindings: [{ key: "Digit5" }] },
  { id: FPS.WEAPON_6, type: "button", name: "Weapon 6", defaultBindings: [{ key: "Digit6" }] },
  { id: FPS.WEAPON_7, type: "button", name: "Weapon 7", defaultBindings: [{ key: "Digit7" }] },
  { id: FPS.WEAPON_8, type: "button", name: "Weapon 8", defaultBindings: [{ key: "Digit8" }] },
  { id: FPS.WEAPON_9, type: "button", name: "Weapon 9", defaultBindings: [{ key: "Digit9" }] },
  { id: FPS.WEAPON_NEXT, type: "button", name: "Next Weapon", defaultBindings: [{ scrollDirection: "down" }] },
  { id: FPS.WEAPON_PREV, type: "button", name: "Prev Weapon", defaultBindings: [{ scrollDirection: "up" }] },

  // --- HUD / UI ---
  { id: FPS.SCOREBOARD, type: "button", name: "Scoreboard", defaultBindings: [{ key: "Tab" }] },
  { id: FPS.CHAT, type: "button", name: "Chat", defaultBindings: [{ key: "KeyT" }] },
  { id: FPS.TEAM_CHAT, type: "button", name: "Team chat", defaultBindings: [{ key: "KeyY" }] },
  { id: FPS.READY, type: "button", name: "Ready Up", defaultBindings: [{ key: "F4" }] },
  { id: FPS.JOIN_GAME, type: "button", name: "Join Game", defaultBindings: [{ key: "KeyJ" }] },
  { id: FPS.CONSOLE, type: "button", name: "Console", defaultBindings: [{ key: "Backquote" }] },
];

// ==================== Context Definitions ====================

/** FPS gameplay context — all combat + movement actions active */
const FPS_GAMEPLAY_CONTEXT = {
  id: "fps_gameplay",
  blocking: false,
  actions: [
    FPS.MOVE_FORWARD,
    FPS.MOVE_BACKWARD,
    FPS.MOVE_LEFT,
    FPS.MOVE_RIGHT,
    FPS.JUMP,
    FPS.CROUCH,
    FPS.SPRINT,
    FPS.FIRE,
    FPS.AIM,
    FPS.RELOAD,
    FPS.USE,
    FPS.WEAPON_1,
    FPS.WEAPON_2,
    FPS.WEAPON_3,
    FPS.WEAPON_4,
    FPS.WEAPON_5,
    FPS.WEAPON_6,
    FPS.WEAPON_7,
    FPS.WEAPON_8,
    FPS.WEAPON_9,
    FPS.WEAPON_NEXT,
    FPS.WEAPON_PREV,
    FPS.SCOREBOARD,
    FPS.CHAT,
    FPS.TEAM_CHAT,
    FPS.READY,
    FPS.CONSOLE,
  ],
};

/** Spectator context — movement + UI only, no combat */
const FPS_SPECTATOR_CONTEXT = {
  id: "fps_spectator",
  blocking: false,
  actions: [
    FPS.MOVE_FORWARD,
    FPS.MOVE_BACKWARD,
    FPS.MOVE_LEFT,
    FPS.MOVE_RIGHT,
    FPS.FLY_UP,
    FPS.FLY_DOWN,
    FPS.SPRINT,
    FPS.SCOREBOARD,
    FPS.CHAT,
    FPS.TEAM_CHAT,
    FPS.JOIN_GAME,
    FPS.CONSOLE,
  ],
};

// ==================== Registration ====================

let _registered = false;

/**
 * Register all FPS actions and contexts with the InputSystem.
 * Safe to call multiple times (idempotent).
 */
export function registerFPSActions(): void {
  if (_registered) return;
  _registered = true;

  const input = InputSystem.getInstance();

  // Register all actions
  for (const def of FPS_ACTION_DEFS) {
    input.registerAction(def);
  }

  // Register contexts
  input.registerContext(FPS_GAMEPLAY_CONTEXT);
  input.registerContext(FPS_SPECTATOR_CONTEXT);

  // Activate gameplay context by default (spectator can be pushed later)
  input.pushContext("fps_gameplay");

  console.log(`[FPSActions] Registered ${FPS_ACTION_DEFS.length} actions, 2 contexts (gameplay active)`);
}

// ==================== Helpers ====================

/**
 * Get the weapon slot number (1-9) for any weapon action that was pressed this frame.
 * Returns 0 if no weapon key was pressed.
 */
export function getWeaponSlotPressed(): number {
  const input = InputSystem.getInstance();
  for (let i = 1; i <= 9; i++) {
    const actionId = `fps_weapon_${i}`;
    if (input.wasPressed(actionId)) return i;
  }
  return 0;
}

/**
 * Get the human-readable label for a key code (for HUD display).
 */
export function getKeyLabel(code: string): string {
  // Strip common prefixes for clean display
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Space") return "SPACE";
  if (code === "ShiftLeft" || code === "ShiftRight") return "SHIFT";
  if (code === "ControlLeft" || code === "ControlRight") return "CTRL";
  if (code === "AltLeft" || code === "AltRight") return "ALT";
  if (code === "Backquote") return "`";
  if (code === "Tab") return "TAB";
  if (code === "Escape") return "ESC";
  if (code === "Enter") return "ENTER";
  if (code.startsWith("Arrow")) return code.slice(5).toUpperCase();
  if (code.startsWith("F") && code.length <= 3) return code; // F1-F12
  return code;
}

/**
 * Get the display label for the first binding of an action.
 */
export function getActionKeyLabel(actionId: string): string {
  const input = InputSystem.getInstance();
  const bindings = input.getBindingsForAction(actionId);
  if (!bindings || bindings.length === 0) return "?";

  const b = bindings[0];
  if (b.key) return getKeyLabel(b.key);
  if (b.mouseButton === "left") return "MOUSE1";
  if (b.mouseButton === "right") return "MOUSE2";
  if (b.mouseButton === "middle") return "MOUSE3";
  return "?";
}
