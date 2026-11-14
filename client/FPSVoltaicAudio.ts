import { AudioManager } from "../../../engine/AudioManager";
import { Attenuation, type LoopSfxPlayOptions, type SfxLoop } from "../../../engine/audio/AudioV2Sfx";
import { background } from "../../../engine/core/AsyncErrors";
import type { TransformComponent } from "../../../engine/network/components/TransformComponent";
import type { SnapshotEvent, WeaponFireEvent, WeaponStateEvent } from "../../../engine/network/core/SnapshotEvent";
import type { GameState } from "../../../shared/net/GameState";
import { canonicalWeaponId } from "../shared/entities/definitions/weapons/WeaponsTable";

export const VOLTAIC_SOUNDS = {
  start: "sounds/weapons/laser_strong_fire.ogg",
  stop: "sounds/weapons/laser_strong_stop.ogg",
} as const;

export function voltaicLoopOptions(quad: boolean, attack: boolean): LoopSfxPlayOptions {
  return {
    volume: 0.9,
    attenuation: Attenuation.Normal,
    pitch: quad ? 150 : 0,
    loopRegion: { startSeconds: 0.1, endSeconds: 0.25 },
    overlapSeconds: 0.03,
    ...(attack ? { intro: { path: VOLTAIC_SOUNDS.start, holdSeconds: 0.12, fadeSeconds: 0.06 } } : {}),
  };
}

type Position = { x: number; y: number; z: number };
interface Voice {
  entityId: string;
  position: Position;
  viewed: boolean;
  quad: boolean;
  lastFireTick: number;
  cancellation: AbortController;
  loop: SfxLoop | null;
  attack: boolean;
}

/** One sustained beam voice per shooter, refreshed by authoritative snapshots. */
export class FPSVoltaicAudio {
  private readonly voices = new Map<string, Voice>();
  /** What one snapshot says, per entity; refilled by every `present`. */
  private readonly scratch = {
    weapons: new Map<string, WeaponStateEvent>(),
    shots: new Map<string, WeaponFireEvent>(),
    dead: new Set<string>(),
    quad: new Set<string>(),
    candidates: new Set<string>(),
  };
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private playing = true;
  private playbackSpeed = 1;

  setPlayback(playing: boolean, speed = 1): void {
    this.playing = playing;
    this.playbackSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
    if (!playing) this.reset();
  }

  present(state: GameState, viewedEntityId?: string, present = true, tickRate = 125): void {
    if (!present || !this.playing) {
      this.reset();
      return;
    }
    // Collections kept between snapshots and cleared, not built each time
    const { weapons, shots, dead, quad, candidates } = this.scratch;
    weapons.clear();
    shots.clear();
    dead.clear();
    quad.clear();
    candidates.clear();
    for (const event of state.events as SnapshotEvent[]) {
      if (event.type === "weapon_state") weapons.set(event.entityId, event);
      else if (event.type === "weapon_fire" && canonicalWeaponId(event.weaponId) === "voltaic") {
        shots.set(event.entityId, event);
      } else if (event.type === "death" || (event.type === "combat_state" && event.dead)) {
        dead.add(event.entityId);
      } else if (event.type === "powerup_state" && event.kind === "quad" && event.seconds > 0) {
        quad.add(event.entityId);
      }
    }

    // A copy of the ids: stopping a voice removes it from this.voices mid-loop
    for (const entityId of this.voices.keys()) candidates.add(entityId);
    for (const entityId of shots.keys()) candidates.add(entityId);
    for (const entityId of candidates) {
      const previous = this.voices.get(entityId);
      const entity = state.entities.get(entityId);
      const weapon = weapons.get(entityId);
      const shot = shots.get(entityId);
      const position = entity?.getComponent<TransformComponent>("transform")?.position ?? previous?.position;
      if (!entity || dead.has(entityId) || !position) {
        this.stop(entityId, false);
        continue;
      }
      const viewed = entityId === viewedEntityId;
      const lastFireTick = Math.max(
        previous?.lastFireTick ?? -Infinity,
        shot ? state.tick : -Infinity,
        Number.isFinite(weapon?.lastFireTick) ? weapon!.lastFireTick : -Infinity,
      );
      if (
        (weapon && (canonicalWeaponId(weapon.currentWeapon) !== "voltaic" || weapon.reloading)) ||
        state.tick < lastFireTick ||
        state.tick - lastFireTick > Math.ceil(tickRate * 0.12)
      ) {
        // A final shot that immediately reloads still needs its attack cue.
        if (shot && !previous) this.cue(VOLTAIC_SOUNDS.start, viewed, position);
        this.stop(entityId, true);
        continue;
      }

      const powered = quad.has(entityId);
      if (!previous || previous.viewed !== viewed || previous.quad !== powered) {
        this.stop(entityId, false);
        const voice: Voice = {
          entityId,
          position: { ...position },
          viewed,
          quad: powered,
          lastFireTick,
          cancellation: new AbortController(),
          loop: null,
          attack: !previous,
        };
        this.voices.set(entityId, voice);
        background(this.startLoop(voice), "Voltaic audio");
      } else {
        previous.lastFireTick = lastFireTick;
        previous.position = { ...position };
        previous.loop?.setPosition?.(position);
      }
    }
    this.armWatchdog();
  }

  reset(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
    for (const id of this.voices.keys()) this.stop(id, false);
  }

  private async startLoop(voice: Voice): Promise<void> {
    const loop = await AudioManager.getInstance().playLoop3D(
      VOLTAIC_SOUNDS.start,
      voice.viewed ? null : voice.position,
      voltaicLoopOptions(voice.quad, voice.attack),
      voice.cancellation.signal,
    );
    if (this.voices.get(voice.entityId) !== voice) {
      loop?.stop();
      return;
    }
    voice.loop = loop;
    loop?.setPosition?.(voice.position);
  }

  private stop(entityId: string, release: boolean): void {
    const voice = this.voices.get(entityId);
    if (!voice) return;
    this.voices.delete(entityId);
    voice.cancellation.abort();
    voice.loop?.stop();
    if (release && voice.loop) this.cue(VOLTAIC_SOUNDS.stop, voice.viewed, voice.position);
  }

  private cue(path: string, viewed: boolean, position: Position): void {
    const audio = AudioManager.getInstance();
    if (viewed) audio.playSfx2D(path, 0.9, 2);
    else audio.playSfx3D(path, position, { volume: 0.9 });
  }

  private armWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog =
      this.voices.size > 0 && !AudioManager.getInstance().hasSfxSink
        ? setTimeout(() => this.reset(), Math.max(500, 250 / this.playbackSpeed))
        : null;
  }
}
