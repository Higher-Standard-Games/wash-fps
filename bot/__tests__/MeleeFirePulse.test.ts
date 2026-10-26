/**
 * Bots holding the blade: the blade swings only on a fresh press, so held fire
 * swung once and then never again while the bot circled its target.
 */

import { describe, expect, it } from "vitest";
import { InputButtons } from "../BotConfig";
import { pulseMeleeFire } from "../BotWeaponProfile";

/** Commands sent with fire held for `ticks` ticks; true where fire is pressed. */
function sent(weaponId: string, ticks: number): boolean[] {
  const out: boolean[] = [];
  let pressed = false;
  for (let i = 0; i < ticks; i++) {
    const result = pulseMeleeFire(InputButtons.FIRE | InputButtons.FORWARD, weaponId, pressed);
    pressed = result.pressed;
    expect(result.buttons & InputButtons.FORWARD).toBe(InputButtons.FORWARD);
    out.push((result.buttons & InputButtons.FIRE) !== 0);
  }
  return out;
}

describe("melee fire pulse", () => {
  it("presses and releases the blade on alternate commands, a fresh press every second tick", () => {
    expect(sent("blade", 6)).toEqual([true, false, true, false, true, false]);
  });

  it("leaves held fire alone on other weapons, which repeat while held", () => {
    expect(sent("rlauncher", 4)).toEqual([true, true, true, true]);
  });

  it("does nothing without fire, and starts on a press when fire returns", () => {
    expect(pulseMeleeFire(InputButtons.FORWARD, "blade", true)).toEqual({
      buttons: InputButtons.FORWARD,
      pressed: false,
    });
    expect(pulseMeleeFire(InputButtons.FIRE, "blade", false).pressed).toBe(true);
  });
});
