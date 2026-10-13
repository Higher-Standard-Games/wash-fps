import { AudioManager } from "../../../engine/AudioManager";
import { Attenuation } from "../../../engine/audio/AudioV2Sfx";
import type {
  DamageEvent,
  DeathEvent,
  ProjectileImpactEvent,
  WeaponFireEvent,
} from "../../../engine/network/core/SnapshotEvent";
import { canonicalWeaponId } from "../../../shared/entities/definitions/weapons/WeaponsTable";

const weaponFireSounds: Readonly<Record<string, readonly string[]>> = {
  blade: ["sounds/weapons/blade_strike1.ogg", "sounds/weapons/blade_strike2.ogg", "sounds/weapons/blade_strike3.ogg"],
  machinegun: ["sounds/weapons/machinegun_fire.ogg"],
  riotgun: ["sounds/weapons/riotgun_fire_strong.ogg"],
  glauncher: ["sounds/weapons/grenlaunch_strong.ogg"],
  rlauncher: ["sounds/weapons/rocket_fire_strong.ogg"],
  plasmagun: [
    "sounds/weapons/plasmagun_strong1.ogg",
    "sounds/weapons/plasmagun_strong2.ogg",
    "sounds/weapons/plasmagun_strong3.ogg",
  ],
  voltaic: ["sounds/weapons/laser_strong_fire.ogg"],
  electrobolt: ["sounds/weapons/electrobolt_strong.ogg"],
  instagun: ["sounds/weapons/instagun_strong.ogg"],
};

const projectileImpactSounds: Readonly<Record<string, readonly string[]>> = {
  grenade: ["sounds/weapons/gren_strong_explosion1.ogg", "sounds/weapons/gren_strong_explosion2.ogg"],
  glauncher: ["sounds/weapons/gren_strong_explosion1.ogg", "sounds/weapons/gren_strong_explosion2.ogg"],
  plasma_bolt: ["sounds/weapons/plasmagun_strong_explosion.ogg"],
  plasmagun: ["sounds/weapons/plasmagun_strong_explosion.ogg"],
  blade_blast: [
    "sounds/weapons/bladegun_strong_hit_1.ogg",
    "sounds/weapons/bladegun_strong_hit_2.ogg",
    "sounds/weapons/bladegun_strong_hit_3.ogg",
  ],
  rocket: ["sounds/weapons/rocket_strong_explosion.ogg"],
  rlauncher: ["sounds/weapons/rocket_strong_explosion.ogg"],
};

/** Plasma fire is quieter at range than the rest, as in Warsow. */
const fireAttenuation: Readonly<Record<string, number>> = { plasmagun: Attenuation.Idle };

/** Explosions carry; small impacts fade quickly. */
const impactAttenuation: Readonly<Record<string, number>> = {
  grenade: Attenuation.Distant,
  glauncher: Attenuation.Distant,
  rocket: Attenuation.Distant,
  rlauncher: Attenuation.Distant,
  plasma_bolt: Attenuation.Idle,
  plasmagun: Attenuation.Idle,
  blade_blast: Attenuation.Normal,
};

const damageConfirmationSounds = [
  "sounds/misc/hit_0.wav",
  "sounds/misc/hit_1.wav",
  "sounds/misc/hit_2.wav",
  "sounds/misc/hit_3.wav",
] as const;

const bobotPainSounds = [
  "sounds/players/bobot/pain25.ogg",
  "sounds/players/bobot/pain50.ogg",
  "sounds/players/bobot/pain75.ogg",
  "sounds/players/bobot/pain100.ogg",
] as const;

export const BOBOT_DEATH_SOUND = "sounds/players/bobot/death.ogg";
export const KILL_ECHO_SOUND = "sounds/misc/kill.wav";
export const EMPTY_CLIP_SOUND = "sounds/weapons/weapon_noammo.ogg";
const FIRE_VOLUME = 0.9;

export const FPS_COMBAT_SOUND_PATHS = [
  ...new Set([
    ...Object.values(weaponFireSounds).flat(),
    ...Object.values(projectileImpactSounds).flat(),
    ...damageConfirmationSounds,
    ...bobotPainSounds,
    BOBOT_DEATH_SOUND,
    KILL_ECHO_SOUND,
    EMPTY_CLIP_SOUND,
  ]),
] as const;

let variantSequence = 0;

function chooseVariant(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const path = paths[variantSequence % paths.length];
  variantSequence++;
  return path;
}

export function getWeaponFireSounds(weaponId: string): readonly string[] {
  return weaponFireSounds[canonicalWeaponId(weaponId)] ?? [];
}

export function getProjectileImpactSounds(defId: string): readonly string[] {
  return projectileImpactSounds[defId] ?? ["sounds/weapons/rocket_strong_explosion.ogg"];
}

/** Predecode the compact combat bank once the map's PK3 index is available. */
export async function preloadFPSCombatAudio(): Promise<void> {
  await AudioManager.getInstance().preloadSfx(FPS_COMBAT_SOUND_PATHS);
}

/**
 * The click of a trigger on an empty gun.
 *
 * Played locally off the client's own ammo state rather than waiting for the
 * server, because it is feedback on your own trigger pull and a round trip late
 * is a round trip too late. Unlike a muzzle flash it claims nothing happened, so
 * mispredicting it costs nothing — it is the same derivation that already drives
 * the out-of-ammo crosshair.
 */
export function playEmptyClipSound(): void {
  AudioManager.getInstance().playSfx2D(EMPTY_CLIP_SOUND, 0.8, 2);
}

export function playWeaponFireSound(event: WeaponFireEvent, localShooter: boolean): void {
  const path = chooseVariant(getWeaponFireSounds(event.weaponId));
  if (!path) return;

  // The same level for everyone's gun: distance alone sets them apart
  const audio = AudioManager.getInstance();
  if (localShooter) {
    audio.playSfx2D(path, FIRE_VOLUME, 6);
  } else {
    audio.playSfx3D(
      path,
      { x: event.originX, y: event.originY, z: event.originZ },
      { volume: FIRE_VOLUME, attenuation: fireAttenuation[canonicalWeaponId(event.weaponId)] ?? Attenuation.Normal },
    );
  }
}

export function playProjectileImpactSound(event: ProjectileImpactEvent): void {
  const path = chooseVariant(getProjectileImpactSounds(event.defId));
  if (!path) return;
  AudioManager.getInstance().playSfx3D(path, event, {
    volume: 1,
    attenuation: impactAttenuation[event.defId] ?? Attenuation.Distant,
  });
}

/** Warsow hit confirmation: only the attacker hears it, independent of world distance. */
export function playDamageConfirmationSound(event: DamageEvent): void {
  if (event.damage <= 0) return;
  const path = chooseVariant(damageConfirmationSounds);
  if (path) AudioManager.getInstance().playSfx2D(path, 0.72, 4);
}

export function playPlayerPainSound(event: DamageEvent, localVictim: boolean): void {
  if (event.damage <= 0) return;
  const tier = event.damage >= 75 ? 3 : event.damage >= 50 ? 2 : event.damage >= 25 ? 1 : 0;
  const path = bobotPainSounds[tier];
  const audio = AudioManager.getInstance();
  if (localVictim) audio.playSfx2D(path, 0.65, 2);
  else audio.playSfx3D(path, event, { volume: 0.72 });
}

/** Bobot is the initial Washoi player voice until model-specific banks are configured. */
export function playPlayerDeathSound(event: DeathEvent, localVictim: boolean): void {
  const audio = AudioManager.getInstance();
  if (localVictim) audio.playSfx2D(BOBOT_DEATH_SOUND, 0.9, 1);
  else audio.playSfx3D(BOBOT_DEATH_SOUND, event, { volume: 0.95 });
}

/** The deliberately huge Warsow frag confirmation echo. */
export function playKillEcho(): void {
  AudioManager.getInstance().playSfx2D(KILL_ECHO_SOUND, 1, 2);
}
