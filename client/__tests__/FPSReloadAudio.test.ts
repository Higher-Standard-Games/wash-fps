import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeaponStateEvent } from "../../../../engine/network/core/SnapshotEvent";

const audio = { playSfx2D: vi.fn(), playSfx3D: vi.fn() };
vi.mock("../../../../engine/AudioManager", () => ({ AudioManager: { getInstance: () => audio } }));

import { FPSReloadAudio, RELOAD_SOUND_PATH } from "../FPSReloadAudio";

const event = (reloading: boolean, entityId = "one", currentWeapon = "machinegun"): WeaponStateEvent => ({
  type: "weapon_state",
  entityId,
  currentWeapon,
  reloading,
  weapons: [],
  ammo: {},
  lastFireTick: 0,
});

describe("reload audio", () => {
  beforeEach(() => vi.clearAllMocks());

  it("plays once per reload, including the next reload after completion", () => {
    const cues = new FPSReloadAudio();
    cues.observe(event(true), true);
    cues.observe(event(true), true);
    expect(audio.playSfx2D).toHaveBeenCalledTimes(1);
    cues.observe(event(false), true);
    cues.observe(event(true), true);
    expect(audio.playSfx2D).toHaveBeenCalledTimes(2);
    expect(audio.playSfx2D).toHaveBeenCalledWith(RELOAD_SOUND_PATH, 0.65, 2);
  });

  it("places other players' cues in the world and keeps the viewed POV in 2D", () => {
    const cues = new FPSReloadAudio();
    const position = { x: 1, y: 2, z: 3 };
    cues.observe(event(true), false, position);
    cues.observe(event(true, "two"), true, position);
    expect(audio.playSfx3D).toHaveBeenCalledWith(RELOAD_SOUND_PATH, position, { volume: 0.65 });
    expect(audio.playSfx2D).toHaveBeenCalledTimes(1);
  });

  it("primes a seek landing silently and does not replay the in-progress reload", () => {
    const cues = new FPSReloadAudio();
    cues.observe(event(true), true, undefined, false);
    cues.observe(event(true), true);
    expect(audio.playSfx2D).not.toHaveBeenCalled();
    cues.reset();
    cues.observe(event(true), true);
    expect(audio.playSfx2D).toHaveBeenCalledTimes(1);
  });

  it("ignores pool ammo and legacy events without a reload flag", () => {
    const cues = new FPSReloadAudio();
    cues.observe(event(true, "one", "rlauncher"), true);
    cues.observe({ ...event(true), reloading: undefined } as unknown as WeaponStateEvent, true);
    expect(audio.playSfx2D).not.toHaveBeenCalled();
  });

  it("forgets despawned entities and tracks a new weapon independently", () => {
    const cues = new FPSReloadAudio();
    cues.observe(event(true), true);
    cues.observe(event(true, "one", "plasmagun"), true);
    cues.prune([]);
    cues.observe(event(true), true);
    expect(audio.playSfx2D).toHaveBeenCalledTimes(3);
  });
});
