import { beforeEach, describe, expect, it, vi } from "vitest";

const audio = {
  preloadSfx: vi.fn(async () => {}),
  playSfx2D: vi.fn(),
  playSfx3D: vi.fn(),
};

vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: { getInstance: () => audio },
}));

import { Attenuation } from "../../../../engine/audio/AudioV2Sfx";
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
  playProjectileImpactSound,
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

  it("keeps own weapon fire listener-relative and remote fire spatial, at the same level", () => {
    playWeaponFireSound(fireEvent, true);
    expect(audio.playSfx2D).toHaveBeenCalledWith("sounds/weapons/rocket_fire_strong.ogg", 0.9, 6);

    playWeaponFireSound(fireEvent, false);
    expect(audio.playSfx3D).toHaveBeenCalledWith(
      "sounds/weapons/rocket_fire_strong.ogg",
      { x: 10, y: 20, z: 30 },
      { volume: 0.9, attenuation: Attenuation.Normal },
    );
  });

  it("fades plasma fire faster, and lets explosions carry", () => {
    playWeaponFireSound({ ...fireEvent, weaponId: "plasmagun" }, false);
    expect(audio.playSfx3D.mock.calls.at(-1)?.[2]).toMatchObject({ attenuation: Attenuation.Idle });
    playProjectileImpactSound({ type: "projectile_impact", defId: "rocket", x: 0, y: 0, z: 0 } as never);
    expect(audio.playSfx3D.mock.calls.at(-1)?.[2]).toMatchObject({ attenuation: Attenuation.Distant });
  });

  it("plays attacker confirmation, Bobot pain/death, and the frag echo on their intended channels", () => {
    playDamageConfirmationSound(damageEvent);
    expect(audio.playSfx2D.mock.calls[0][0]).toMatch(/^sounds\/misc\/hit_[0-3]\.wav$/);

    playPlayerPainSound(damageEvent, false);
    expect(audio.playSfx3D).toHaveBeenCalledWith("sounds/players/bobot/pain75.ogg", damageEvent, expect.any(Object));

    playPlayerDeathSound(deathEvent, true);
    expect(audio.playSfx2D).toHaveBeenCalledWith(BOBOT_DEATH_SOUND, 0.9, 1, "players");

    playKillEcho();
    expect(audio.playSfx2D).toHaveBeenCalledWith(KILL_ECHO_SOUND, 1, 2, "hits");
  });

  it("says how hard a hit was: hit_0 the lightest, hit_3 from 75 damage", () => {
    for (const damage of [5, 25, 50, 75, 120]) playDamageConfirmationSound({ ...damageEvent, damage });
    expect(audio.playSfx2D.mock.calls.map(([path]) => path)).toEqual([
      "sounds/misc/hit_0.wav",
      "sounds/misc/hit_1.wav",
      "sounds/misc/hit_2.wav",
      "sounds/misc/hit_3.wav",
      "sounds/misc/hit_3.wav",
    ]);
  });

  it("picks the pain by how hurt the victim is, when the server says", () => {
    playPlayerPainSound({ ...damageEvent, entityId: "nearly_dead", damage: 5, painTier: 0 }, false, 5000);
    playPlayerPainSound({ ...damageEvent, entityId: "healthy", damage: 90, painTier: 3 }, false, 5000);
    expect(audio.playSfx3D.mock.calls.map(([path]) => path)).toEqual([
      "sounds/players/bobot/pain25.ogg",
      "sounds/players/bobot/pain100.ogg",
    ]);
  });

  it("hears one player's pain at most every 400 ms, and each player apart", () => {
    const hit = { ...damageEvent, entityId: "machinegunned" };
    playPlayerPainSound(hit, false, 1000);
    playPlayerPainSound(hit, false, 1100);
    playPlayerPainSound({ ...hit, entityId: "bystander" }, false, 1150);
    playPlayerPainSound(hit, false, 1400);
    expect(audio.playSfx3D).toHaveBeenCalledTimes(3);
  });
});
