import { describe, expect, it } from "vitest";
import { getWeaponProfile } from "../BotWeaponProfile";

describe("BotWeaponProfile", () => {
  it("aims down sights with every gun whose shot ADS tightens, not with the blade", () => {
    for (const id of ["machinegun", "riotgun", "electrobolt", "voltaic", "plasmagun", "rlauncher", "glauncher"]) {
      expect(getWeaponProfile(id).aimsDownSights, id).toBe(true);
    }
    expect(getWeaponProfile("blade").aimsDownSights).toBe(false);
  });

  it("knows which weapons count a shot as aimed only after the sights settle", () => {
    expect(getWeaponProfile("electrobolt").adsReadyTicks).toBe(47);
    expect(getWeaponProfile("rlauncher").adsReadyTicks).toBe(20);
    expect(getWeaponProfile("machinegun").adsReadyTicks).toBe(0);
    expect(getWeaponProfile("voltaic").adsReadyTicks).toBe(0);
  });
});
