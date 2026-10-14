/**
 * The gun's own ammo counter shows the number the HUD shows: the clip for a
 * clip weapon, the plain count otherwise, and zero for an empty hand.
 */

import { describe, expect, it } from "vitest";
import { currentClip, HUDState } from "../HUDState";

describe("currentClip", () => {
  it("reads the weapon in hand the way the HUD does", () => {
    const state = new HUDState();
    state.currentWeapon = "rlauncher";
    state.ammo = { rlauncher: 8 };
    expect(currentClip(state)).toBe(8);

    state.currentWeapon = "machinegun";
    state.ammo = { machinegun: { clip: 10, reserve: 150 } } as unknown as HUDState["ammo"];
    expect(currentClip(state)).toBe(10);

    state.currentWeapon = "blade";
    expect(currentClip(state)).toBe(0);
  });
});
