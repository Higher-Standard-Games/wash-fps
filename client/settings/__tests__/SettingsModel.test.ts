// @vitest-environment jsdom

/**
 * What the settings screen writes: a key does one thing, keys the game reads
 * itself cannot be given away, and every preset and colour choice is the game's
 * own cvars.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../../engine/core/Cvar";
import { InputSystem } from "../../../../../engine/input/InputSystem";
import { RenderVars } from "../../../../../engine/rendering/RenderVars";
import { FPS, registerFPSActions } from "../../FPSActions";
import { registerPlayerModelVisualCvars } from "../../PlayerModelVisualSettings";
import "../../Crosshair";
import {
  actionFor,
  assignKey,
  BOOST_CHOICES,
  CROSSHAIR_COLORS,
  codesFor,
  currentChoice,
  GODRAY_CHOICES,
  godrayChoice,
  HIT_COLORS,
  OUTLINE_CHOICES,
  resetKeys,
  resetPage,
  setSideColor,
  sideColor,
  TEAM_COLORS,
  VIDEO_PRESETS,
} from "../SettingsModel";

const input = InputSystem.getInstance();

beforeAll(() => {
  Cvar.init();
  RenderVars.getInstance();
  registerPlayerModelVisualCvars();
  registerFPSActions();
});

beforeEach(() => {
  input.resetAllBindings();
});

describe("keys", () => {
  it("reads the game's bindings", () => {
    expect(codesFor(FPS.MOVE_FORWARD)).toEqual(["KeyW"]);
    expect(codesFor(FPS.CROUCH)).toEqual(["mouse:middle", "KeyC", "ControlLeft", "ControlRight"]);
    expect(actionFor("wheel:down")?.id).toBe(FPS.WEAPON_NEXT);
  });

  it("gives a key to one action, taking it from the one that had it", () => {
    const result = assignKey("KeyW", FPS.JUMP);

    expect(result).toMatchObject({ kind: "assigned", previous: { id: FPS.MOVE_FORWARD } });
    expect(codesFor(FPS.MOVE_FORWARD)).toEqual([]);
    expect(codesFor(FPS.JUMP)).toEqual(["Space", "KeyW"]);
    expect(input.getBindingsForAction(FPS.JUMP)).toEqual([{ key: "Space" }, { key: "KeyW" }]);
  });

  it("will not give away a key the game reads itself", () => {
    expect(assignKey("Escape", FPS.JUMP)).toMatchObject({ kind: "fixed", action: { id: "cancel" } });
    expect(actionFor("Escape")?.name).toBe("Menu / cancel");
    expect(assignKey("Tab", FPS.JUMP)).toMatchObject({ kind: "fixed", action: { id: FPS.SCOREBOARD } });
    expect(assignKey("Enter", null)).toMatchObject({ kind: "fixed", action: { id: FPS.CHAT } });
    expect(codesFor(FPS.JUMP)).toEqual(["Space"]);
    expect(input.exportBindings()).toEqual({});
  });

  it("shows the keys a fixed action answers to, whatever its binding says", () => {
    expect(codesFor(FPS.CHAT)).toEqual(["KeyT", "Enter"]);
    expect(actionFor("KeyJ")?.id).toBe(FPS.JOIN_GAME);
  });

  it("takes a key from the weapon slots the screen does not list", () => {
    // Slots four to nine hold the digits, though a player carries three weapons
    expect(input.getBindingsForAction(FPS.WEAPON_4)).toEqual([{ key: "Digit4" }]);
    expect(actionFor("Digit4")).toBeNull();

    assignKey("Digit4", FPS.RELOAD);

    expect(input.getBindingsForAction(FPS.WEAPON_4)).toEqual([]);
    expect(codesFor(FPS.RELOAD)).toEqual(["KeyR", "Digit4"]);
  });

  it("stores nothing once an action is back on its defaults", () => {
    assignKey("KeyW", null);
    expect(input.exportBindings()[FPS.MOVE_FORWARD]).toEqual([]);

    assignKey("KeyW", FPS.MOVE_FORWARD);
    expect(input.exportBindings()[FPS.MOVE_FORWARD]).toBeUndefined();
  });

  it("puts every key back, the unlisted slots included", () => {
    assignKey("Digit5", FPS.JUMP);
    assignKey("KeyW", FPS.FIRE);

    resetKeys();

    expect(input.exportBindings()).toEqual({});
    expect(codesFor(FPS.MOVE_FORWARD)).toEqual(["KeyW"]);
    expect(input.getBindingsForAction(FPS.WEAPON_5)).toEqual([{ key: "Digit5" }]);
  });
});

describe("video", () => {
  beforeEach(() => resetPage("video"));

  it("ships as Balanced", () => {
    expect(currentChoice(VIDEO_PRESETS)?.id).toBe("balanced");
  });

  it("knows a preset once it is applied, and a mix of one's own after", () => {
    for (const preset of VIDEO_PRESETS) {
      for (const [name, value] of Object.entries(preset.values)) Cvar.set(name, value);
      expect(currentChoice(VIDEO_PRESETS)?.id).toBe(preset.id);
    }
    Cvar.set("r_glow", 0.8);
    expect(currentChoice(VIDEO_PRESETS)).toBeNull();
  });

  it("calls light shafts off whatever their sample count", () => {
    Cvar.set("r_godrays", 0);
    Cvar.set("r_godrays_samples", 30);
    expect(godrayChoice().id).toBe("off");
    Cvar.set("r_godrays", 1);
    expect(godrayChoice().id).toBe("low");
    for (const [name, value] of Object.entries(GODRAY_CHOICES[2].values)) Cvar.set(name, value);
    expect(godrayChoice().id).toBe("high");
  });
});

describe("players and the crosshair", () => {
  beforeEach(() => resetPage("gameplay"));

  it("starts on the game's colours, outline and brightness", () => {
    expect(sideColor("ally")?.id).toBe("pink");
    expect(sideColor("enemy")?.id).toBe("cyan");
    expect(currentChoice(OUTLINE_CHOICES)?.id).toBe("thin");
    expect(currentChoice(BOOST_CHOICES)?.id).toBe("off");
    expect(CROSSHAIR_COLORS.map((color) => color.value)).toContain(Cvar.getString("cg_crosshairColor").toUpperCase());
    expect(HIT_COLORS.map((color) => color.value)).toContain(Cvar.getString("cg_crosshairDmgColor").toUpperCase());
  });

  it("colours enemies in free-for-all too", () => {
    const lime = TEAM_COLORS.find((color) => color.id === "lime")!;
    setSideColor("enemy", lime);

    expect(sideColor("enemy")?.id).toBe("lime");
    expect(Cvar.getString("cl_team_ffa_color")).toBe(lime.fill);
    expect(Cvar.getString("cl_team_ffa_outline_color")).toBe(lime.outline);
    expect(sideColor("ally")?.id).toBe("pink");
  });

  it("names no colour when one was set some other way", () => {
    Cvar.set("cl_team_ally_color", "0.3 0.3 0.3");
    expect(sideColor("ally")).toBeNull();
  });

  it("puts the page back on its defaults", () => {
    setSideColor("ally", TEAM_COLORS[2]);
    Cvar.set("cl_player_outline_size", 50);
    resetPage("gameplay");
    expect(sideColor("ally")?.id).toBe("pink");
    expect(currentChoice(OUTLINE_CHOICES)?.id).toBe("thin");
  });
});
