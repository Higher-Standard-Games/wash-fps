import { beforeEach, describe, expect, it, vi } from "vitest";

const audio = {
  preloadSfx: vi.fn(async () => {}),
  playSfx2D: vi.fn(),
  playSfx3D: vi.fn(),
};

vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: { getInstance: () => audio },
}));

import type { DamageEvent, DeathEvent, WeaponFireEvent } from "../../../../engine/network/core/SnapshotEvent";
import {
  BOBOT_DEATH_SOUND,
  FPS_COMBAT_SOUND_PATHS,
  getProjectileImpactSounds,
  getWeaponFireSounds,
  KILL_ECHO_SOUND,
  playDamageConfirmationSound,
  playKillEcho,
  playPlayerDeathSound,
  playPlayerPainSound,
  playWeaponFireSound,
  preloadFPSCombatAudio,
} from "../FPSCombatAudio";

const fireEvent: WeaponFireEvent = {
  type: "weapon_fire",
  entityId: "player_2",
  weaponId: "rlauncher",
  originX: 10,
  originY: 20,
  originZ: 30,
  dirX: 0,
  dirY: 0,
  dirZ: 1,
};

const damageEvent: DamageEvent = {
  type: "damage",
  entityId: "player_2",
  attackerId: "player_1",
  damage: 60,
  weaponId: "rlauncher",
  x: 10,
  y: 20,
  z: 30,
};

const deathEvent: DeathEvent = {
  type: "death",
  entityId: "player_2",
  killerId: "player_1",
  weaponId: "rlauncher",
  damageType: "explosion",
  finalDamage: 80,
  x: 10,
  y: 20,
  z: 30,
  velX: 0,
  velY: 0,
  velZ: 0,
  kbDirX: 0,
  kbDirY: 1,
  kbDirZ: 0,
};

describe("FPSCombatAudio", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps every Washoi weapon and projectile alias to PK3 sound paths", () => {
    for (const weapon of [
      "blade",
      "machinegun",
      "riotgun",
      "glauncher",
      "rlauncher",
      "plasmagun",
      "voltaic",
      "lasergun",
      "electrobolt",
      "instagun",
    ]) {
      expect(getWeaponFireSounds(weapon), weapon).not.toHaveLength(0);
    }
    for (const projectile of ["grenade", "glauncher", "plasma_bolt", "plasmagun", "rocket", "rlauncher"]) {
      expect(getProjectileImpactSounds(projectile), projectile).not.toHaveLength(0);
    }
  });

  it("preloads the complete combat, Bobot pain/death, hit and kill bank", async () => {
    await preloadFPSCombatAudio();
    expect(audio.preloadSfx).toHaveBeenCalledWith(FPS_COMBAT_SOUND_PATHS);
    expect(FPS_COMBAT_SOUND_PATHS).toContain(BOBOT_DEATH_SOUND);
    expect(FPS_COMBAT_SOUND_PATHS).toContain(KILL_ECHO_SOUND);
    expect(FPS_COMBAT_SOUND_PATHS).toContain("sounds/misc/hit_0.wav");
    expect(FPS_COMBAT_SOUND_PATHS).toContain("sounds/players/bobot/pain100.ogg");
  });

  it("keeps own weapon fire listener-relative and remote fire spatial", () => {
    playWeaponFireSound(fireEvent, true);
    expect(audio.playSfx2D).toHaveBeenCalledWith("sounds/weapons/rocket_fire_strong.ogg", 0.9, 6);

    playWeaponFireSound(fireEvent, false);
    expect(audio.playSfx3D).toHaveBeenCalledWith(
      "sounds/weapons/rocket_fire_strong.ogg",
      { x: 10, y: 20, z: 30 },
      { volume: 0.95 },
    );
  });

  it("plays attacker confirmation, Bobot pain/death, and the frag echo on their intended channels", () => {
    playDamageConfirmationSound(damageEvent);
    expect(audio.playSfx2D.mock.calls[0][0]).toMatch(/^sounds\/misc\/hit_[0-3]\.wav$/);

    playPlayerPainSound(damageEvent, false);
    expect(audio.playSfx3D).toHaveBeenCalledWith("sounds/players/bobot/pain75.ogg", damageEvent, expect.any(Object));

    playPlayerDeathSound(deathEvent, true);
    expect(audio.playSfx2D).toHaveBeenCalledWith(BOBOT_DEATH_SOUND, 0.9, 1);

    playKillEcho();
    expect(audio.playSfx2D).toHaveBeenCalledWith(KILL_ECHO_SOUND, 1, 2);
  });
});
