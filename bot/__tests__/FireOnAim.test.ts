/**
 * A bot that notices an enemy behind it turns round before it shoots: the
 * trigger waits until the view is on the aim, then stays down while tracking.
 */

import { describe, expect, it } from "vitest";
import { BotAimController } from "../BotAimController";
import { DIFFICULTY_PRESETS, InputButtons } from "../BotConfig";
import { holdFireOffAim } from "../BotFireSafety";

const DT = 0.008;
const DEG = Math.PI / 180;
const steady = () => 0.5;
const FIRE = InputButtons.FIRE;

describe("fire on aim", () => {
  it("holds fire through a turn to an enemy behind, and fires once the view arrives", () => {
    const aim = new BotAimController({ ...DIFFICULTY_PRESETS.medium, aimAccuracy: 1 }, steady);
    aim.reset(0, 0);
    const wanted = { yaw: Math.PI, pitch: 0 };
    let shooting = false;
    let firstShot = -1;
    let offAtFirstShot = 0;
    for (let i = 0; i < 250; i++) {
      const view = aim.step(DT, wanted.yaw, wanted.pitch, true);
      const held = holdFireOffAim(FIRE | InputButtons.FORWARD, wanted, view, shooting);
      shooting = held.shooting;
      expect(held.buttons & InputButtons.FORWARD).toBe(InputButtons.FORWARD);
      if ((held.buttons & FIRE) !== 0 && firstShot < 0) {
        firstShot = i;
        offAtFirstShot = Math.abs(Math.PI - Math.abs(view.yaw));
      }
    }
    // Medium reacts in about 0.25 s and turns 180° in about half a second more.
    expect(firstShot * DT).toBeGreaterThan(0.4);
    expect(offAtFirstShot).toBeLessThanOrEqual(12 * DEG);
  });

  it("keeps the trigger down while tracking a few degrees behind, and lets go when the aim swings away", () => {
    const aim = { yaw: 0, pitch: 0 };
    const tracking = holdFireOffAim(FIRE, aim, { yaw: 20 * DEG, pitch: 0 }, true);
    expect(tracking).toEqual({ buttons: FIRE, shooting: true });
    expect(holdFireOffAim(FIRE, aim, { yaw: 20 * DEG, pitch: 0 }, false).buttons & FIRE).toBe(0);
    expect(holdFireOffAim(FIRE, aim, { yaw: 40 * DEG, pitch: 0 }, true)).toEqual({ buttons: 0, shooting: false });
  });

  it("leaves alt-fire alone: the sights and the blade's charge come up while turning", () => {
    const alt = InputButtons.ALT_FIRE;
    expect(holdFireOffAim(alt, { yaw: 0, pitch: 0 }, { yaw: Math.PI, pitch: 0 }, false).buttons).toBe(alt);
  });
});
