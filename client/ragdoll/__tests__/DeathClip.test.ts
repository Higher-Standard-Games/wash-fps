import { describe, expect, it } from "vitest";
import { chooseDeathClip, deathClipYaw } from "../DeathClip";

// A victim at yaw 0 faces +Z. A push along +Z came from behind them; one along -Z from the front.
const fromFront = { kbDirX: 0, kbDirZ: -0.6 };
const fromBehind = { kbDirX: 0, kbDirZ: 0.6 };
const fromSide = { kbDirX: 0.6, kbDirZ: 0 };

describe("chooseDeathClip", () => {
  it("plays death_from_back for any kill from behind, headshots and blasts included", () => {
    expect(chooseDeathClip({ damageType: "bullet", ...fromBehind }, 0)).toBe("death_from_back");
    expect(chooseDeathClip({ damageType: "bullet", hitLocation: "head", ...fromBehind }, 0)).toBe("death_from_back");
    expect(chooseDeathClip({ damageType: "explosion", ...fromBehind }, 0)).toBe("death_from_back");
    expect(chooseDeathClip({ damageType: "bullet", killWeapon: "riotgun", ...fromBehind }, 0)).toBe("death_from_back");
  });

  it("plays death_headshot for a headshot from the front or side", () => {
    expect(chooseDeathClip({ damageType: "bullet", hitLocation: "head", ...fromFront }, 0)).toBe("death_headshot");
    expect(chooseDeathClip({ damageType: "bullet", hitLocation: "head", ...fromSide }, 0)).toBe("death_headshot");
  });

  it("plays death_flying_back for a riotgun or explosion kill from the front or side", () => {
    expect(chooseDeathClip({ damageType: "bullet", killWeapon: "riotgun", ...fromFront }, 0)).toBe("death_flying_back");
    expect(chooseDeathClip({ damageType: "explosion", ...fromSide }, 0)).toBe("death_flying_back");
  });

  it("leaves other kills to the plain ragdoll", () => {
    expect(chooseDeathClip({ damageType: "bullet", killWeapon: "machinegun", ...fromFront }, 0)).toBeNull();
    expect(chooseDeathClip({ damageType: "plasma", ...fromFront }, 0)).toBeNull();
    expect(chooseDeathClip({ damageType: "fall", kbDirX: 0, kbDirZ: 0 }, 0)).toBeNull();
  });

  it("has no side for a push straight up, such as a rocket at the feet", () => {
    expect(chooseDeathClip({ damageType: "explosion", kbDirX: 0.01, kbDirZ: 0.02 }, 0)).toBeNull();
  });

  it("judges behind against the victim's yaw", () => {
    // Facing +X (yaw 90 degrees), a push along +X came from behind
    expect(chooseDeathClip({ damageType: "explosion", kbDirX: 0.6, kbDirZ: 0 }, Math.PI / 2)).toBe("death_from_back");
    expect(chooseDeathClip({ damageType: "explosion", kbDirX: 0, kbDirZ: 0.6 }, Math.PI / 2)).toBe("death_flying_back");
  });
});

describe("deathClipYaw", () => {
  const forward = (yaw: number) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });

  it("turns a body thrown from the front to face the shot, so it flies straight back", () => {
    const f = forward(deathClipYaw("death_flying_back", 0.6, 0));
    expect(f.x).toBeCloseTo(-1);
    expect(f.z).toBeCloseTo(0);
  });

  it("turns a body thrown from behind away from the shot, so it flies forward", () => {
    const f = forward(deathClipYaw("death_from_back", 0.6, 0));
    expect(f.x).toBeCloseTo(1);
    expect(f.z).toBeCloseTo(0);
  });
});
