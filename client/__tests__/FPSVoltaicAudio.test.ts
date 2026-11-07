import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SfxLoop } from "../../../../engine/audio/AudioV2Sfx";
import { TransformComponent } from "../../../../engine/network/components/TransformComponent";
import type { SnapshotEvent, WeaponFireEvent, WeaponStateEvent } from "../../../../engine/network/core/SnapshotEvent";
import { Entity } from "../../../../shared/net/Entity";
import { GameState } from "../../../../shared/net/GameState";

const loops: Array<{ stop: ReturnType<typeof vi.fn>; setPosition: ReturnType<typeof vi.fn> }> = [];
const audio = {
  playSfx2D: vi.fn(),
  playSfx3D: vi.fn(),
  playLoop3D: vi.fn(async (..._args: unknown[]): Promise<SfxLoop | null> => {
    const loop = { stop: vi.fn(), setPosition: vi.fn() };
    loops.push(loop);
    return loop;
  }),
};
vi.mock("../../../../engine/AudioManager", () => ({ AudioManager: { getInstance: () => audio } }));

import { FPSVoltaicAudio, VOLTAIC_SOUNDS } from "../FPSVoltaicAudio";
import { FrameEffects } from "../FrameEffects";

function shot(entityId = "one", weaponId = "voltaic"): WeaponFireEvent {
  return { type: "weapon_fire", entityId, weaponId, originX: 1, originY: 2, originZ: 3, dirX: 0, dirY: 0, dirZ: 1 };
}
function weapon(lastFireTick: number, patch: Partial<WeaponStateEvent> = {}): WeaponStateEvent {
  return {
    type: "weapon_state",
    entityId: "one",
    currentWeapon: "voltaic",
    weapons: [],
    ammo: {},
    reloading: false,
    lastFireTick,
    ...patch,
  };
}
function frame(tick: number, events: SnapshotEvent[] = [], ids = ["one"]): GameState {
  const state = new GameState();
  state.tick = tick;
  state.events = events;
  for (const id of ids) {
    const entity = new Entity(id);
    entity.addComponent("transform", new TransformComponent({ position: { x: tick, y: 2, z: 3 } }));
    state.entities.set(id, entity);
  }
  return state;
}

describe("Voltaic sustained audio", () => {
  let owner: FPSVoltaicAudio;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    loops.length = 0;
    owner = new FPSVoltaicAudio();
  });
  afterEach(() => {
    owner.reset();
    vi.useRealTimers();
  });

  it("plays one attack and hum across repeated beam shots, then one release", async () => {
    for (let tick = 0; tick <= 120; tick += 6) {
      owner.present(frame(tick, [shot(), weapon(tick)]), "one");
      await Promise.resolve();
    }
    expect(audio.playSfx2D).not.toHaveBeenCalled();
    expect(audio.playLoop3D).toHaveBeenCalledOnce();
    expect(audio.playLoop3D.mock.calls[0].slice(0, 2)).toEqual([VOLTAIC_SOUNDS.start, null]);
    expect(audio.playLoop3D.mock.calls[0][2]).toMatchObject({
      volume: 0.9,
      overlapSeconds: 0.03,
      intro: { path: VOLTAIC_SOUNDS.start, holdSeconds: 0.12, fadeSeconds: 0.06 },
    });
    owner.present(frame(132, [weapon(120)]), "one");
    expect(loops[0].stop).not.toHaveBeenCalled();
    owner.present(frame(136, [weapon(120)]), "one");
    owner.present(frame(140, [weapon(120)]), "one");
    expect(loops[0].stop).toHaveBeenCalledOnce();
    expect(audio.playSfx2D).toHaveBeenCalledTimes(1);
    expect(audio.playSfx2D).toHaveBeenLastCalledWith(VOLTAIC_SOUNDS.stop, 0.9, 2);
  });

  it("uses authoritative fire ticks across a missing one-shot event without starting stale voices", async () => {
    owner.present(frame(100, [weapon(100)]), "one");
    expect(audio.playLoop3D).not.toHaveBeenCalled();
    owner.present(frame(104, [shot(), weapon(104)]), "one");
    await Promise.resolve();
    owner.present(frame(120, [weapon(116)]), "one");
    expect(loops[0].stop).not.toHaveBeenCalled();
  });

  it.each([{ reloading: true }, { currentWeapon: "machinegun" }])(
    "stops immediately on weapon transition %j",
    async (patch) => {
      owner.present(frame(100, [shot(), weapon(100)]), "one");
      await Promise.resolve();
      owner.present(frame(101, [weapon(100, patch)]), "one");
      expect(loops[0].stop).toHaveBeenCalledOnce();
      expect(audio.playSfx2D).toHaveBeenLastCalledWith(VOLTAIC_SOUNDS.stop, 0.9, 2);
    },
  );

  it("keeps the final shot audible when it immediately starts a reload", () => {
    owner.present(frame(100, [shot(), weapon(100, { reloading: true })]), "one");
    expect(audio.playSfx2D).toHaveBeenCalledExactlyOnceWith(VOLTAIC_SOUNDS.start, 0.9, 2);
    expect(audio.playLoop3D).not.toHaveBeenCalled();
  });

  it.each(["death", "despawn"])("silences a %s without a release cue", async (reason) => {
    owner.present(frame(100, [shot()]), "one");
    await Promise.resolve();
    owner.present(
      reason === "despawn"
        ? frame(101, [], [])
        : frame(101, [{ type: "combat_state", entityId: "one", dead: true, health: 0, armor: 0 }]),
      "one",
    );
    expect(loops[0].stop).toHaveBeenCalledOnce();
    expect(audio.playSfx2D).not.toHaveBeenCalled();
  });

  it("tracks independent moving spatial voices and relocates the viewed POV without another attack", async () => {
    owner.present(frame(100, [shot(), shot("two")], ["one", "two"]), "one");
    await Promise.resolve();
    expect(audio.playSfx2D).not.toHaveBeenCalled();
    expect(audio.playSfx3D).not.toHaveBeenCalled();
    expect(audio.playLoop3D.mock.calls[1][1]).toEqual({ x: 100, y: 2, z: 3 });
    owner.present(frame(104, [], ["one", "two"]), "one");
    expect(loops[1].setPosition).toHaveBeenLastCalledWith({ x: 104, y: 2, z: 3 });
    owner.present(frame(108, [], ["one", "two"]), "two");
    await Promise.resolve();
    expect(loops[0].stop).toHaveBeenCalledOnce();
    expect(loops[1].stop).toHaveBeenCalledOnce();
    expect(audio.playLoop3D.mock.calls[2][1]).toEqual({ x: 108, y: 2, z: 3 });
    expect(audio.playLoop3D.mock.calls[3][1]).toBeNull();
    expect(audio.playSfx2D).not.toHaveBeenCalled();
    expect(audio.playSfx3D).not.toHaveBeenCalled();
    expect(audio.playLoop3D.mock.calls[2][2]).not.toHaveProperty("intro");
    expect(audio.playLoop3D.mock.calls[3][2]).not.toHaveProperty("intro");
  });

  it("raises the firing-body pitch during quad without replaying the attack", async () => {
    owner.present(
      frame(100, [shot("one", "lasergun"), { type: "powerup_state", entityId: "one", kind: "quad", seconds: 2 }]),
      "one",
    );
    await Promise.resolve();
    expect(audio.playLoop3D.mock.calls[0][0]).toBe(VOLTAIC_SOUNDS.start);
    expect(audio.playLoop3D.mock.calls[0][2]).toMatchObject({ volume: 0.9, overlapSeconds: 0.03, pitch: 150 });
    owner.present(frame(104), "one");
    await Promise.resolve();
    expect(loops[0].stop).toHaveBeenCalledOnce();
    expect(audio.playLoop3D.mock.calls[1][0]).toBe(VOLTAIC_SOUNDS.start);
    expect(audio.playSfx2D).not.toHaveBeenCalled();
    expect(audio.playLoop3D.mock.calls[1][2]).not.toHaveProperty("intro");
  });

  it("cancels a pending load on reset and rejects its late handle", async () => {
    let resolve!: (loop: SfxLoop) => void;
    audio.playLoop3D.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    owner.present(frame(100, [shot()]), "one");
    const signal = audio.playLoop3D.mock.calls[0][3] as AbortSignal;
    owner.reset();
    expect(signal.aborted).toBe(true);
    const late = { stop: vi.fn() };
    resolve(late);
    await Promise.resolve();
    expect(late.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("silences seek, pause and map teardown, and can start a fresh burst afterwards", async () => {
    const effects = new FrameEffects(() => null);
    owner = effects.voltaicAudio;
    owner.present(frame(100, [shot()]), "one");
    await Promise.resolve();
    effects.clearWorld();
    expect(loops[0].stop).toHaveBeenCalledOnce();
    owner.present(frame(100, [shot()]), "one", false);
    owner.setPlayback(false);
    owner.present(frame(104, [shot()]), "one");
    expect(audio.playLoop3D).toHaveBeenCalledOnce();
    owner.setPlayback(true);
    owner.present(frame(108, [shot()]), "one");
    await Promise.resolve();
    owner.setPlayback(false);
    expect(loops[1].stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after lost snapshots and scales the watchdog for slow demo playback", async () => {
    owner.present(frame(100, [shot()]), "one");
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(loops[0].stop).toHaveBeenCalledOnce();
    owner.setPlayback(true, 0.1);
    owner.present(frame(200, [shot()]), "one");
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    expect(loops[1].stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(loops[1].stop).toHaveBeenCalledOnce();
  });

  it("uses the demo tick rate for release grace", async () => {
    owner.present(frame(100, [shot()]), "one", true, 60);
    await Promise.resolve();
    owner.present(frame(109, [weapon(100)]), "one", true, 60);
    expect(loops[0].stop).toHaveBeenCalledOnce();
  });
});
