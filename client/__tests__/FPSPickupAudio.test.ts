import { beforeEach, describe, expect, it, vi } from "vitest";

const audio = {
  preloadSfx: vi.fn(async () => {}),
  playSfx2D: vi.fn(),
  playSfx3D: vi.fn(),
};

vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: { getInstance: () => audio },
}));

import { FPS_PICKUP_SOUND_PATHS, getPickupSound, playPickupSound, preloadFPSPickupAudio } from "../FPSPickupAudio";

describe("FPSPickupAudio", () => {
  beforeEach(() => vi.clearAllMocks());

  // Labels are the exact strings produced by PickupSystem.pickupLabel().
  it("maps every armor tier to its own sound", () => {
    expect(getPickupSound("Armor Shard")).toBe("sounds/items/armor_shard.ogg");
    expect(getPickupSound("Green Armor")).toBe("sounds/items/armor_green.ogg");
    expect(getPickupSound("Yellow Armor")).toBe("sounds/items/armor_yellow.ogg");
    expect(getPickupSound("Red Armor")).toBe("sounds/items/armor_red.ogg");
  });

  it("distinguishes mega/ultra health from regular health", () => {
    expect(getPickupSound("Mega Health")).toBe("sounds/items/megahealth.ogg");
    expect(getPickupSound("Ultra Health")).toBe("sounds/items/megahealth.ogg");
    expect(getPickupSound("Health")).toBe("sounds/items/health_25.ogg");
  });

  it("maps ammo labels to the ammo pickup and weapons to the weapon pickup", () => {
    expect(getPickupSound("Bullets Ammo")).toBe("sounds/items/ammo_pickup.ogg");
    expect(getPickupSound("Cells Ammo")).toBe("sounds/items/ammo_pickup.ogg");
    expect(getPickupSound("Machinegun")).toBe("sounds/items/weapon_pickup.ogg");
    expect(getPickupSound("Grenade Launcher")).toBe("sounds/items/weapon_pickup.ogg");
  });

  it("plays a 2D one-shot for a real label, and stays silent on an empty label", () => {
    playPickupSound("Red Armor");
    expect(audio.playSfx2D).toHaveBeenCalledWith("sounds/items/armor_red.ogg", expect.any(Number), expect.any(Number));

    audio.playSfx2D.mockClear();
    playPickupSound("");
    expect(audio.playSfx2D).not.toHaveBeenCalled();
  });

  it("preloads the deduped item bank", async () => {
    await preloadFPSPickupAudio();
    expect(audio.preloadSfx).toHaveBeenCalledWith(FPS_PICKUP_SOUND_PATHS);
    expect(FPS_PICKUP_SOUND_PATHS).toContain("sounds/items/megahealth.ogg");
    expect(FPS_PICKUP_SOUND_PATHS).toContain("sounds/items/weapon_pickup.ogg");
    // deduped
    expect(new Set(FPS_PICKUP_SOUND_PATHS).size).toBe(FPS_PICKUP_SOUND_PATHS.length);
  });
});
