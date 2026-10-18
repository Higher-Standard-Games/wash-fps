import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: { getInstance: () => ({ playSfx2D: vi.fn() }) },
}));

import { FPSAnnouncer } from "../FPSAnnouncer";
import { FPSBombAudio } from "../FPSBombAudio";
import type { BombObjectiveSnapshot } from "../MatchStateManager";

function bomb(phase: string): BombObjectiveSnapshot {
  return {
    kind: "bomb",
    phase,
    x: 0,
    y: 0,
    z: 0,
    siteId: 0,
    carrier: null,
    progress: 0,
    advancing: false,
    worker: null,
    fuse: null,
    beepInterval: null,
    sites: [],
  };
}

describe("bomb phase announcements", () => {
  it.each([true, false])("announces placement and arming to the correct side (attacking=%s)", (attacking) => {
    const announcer = new FPSAnnouncer();
    const queue = vi.spyOn(announcer, "queue").mockImplementation(() => {});
    const audio = new FPSBombAudio(announcer);
    audio.update(bomb("carried"), 0, attacking);
    audio.update(bomb("planted"), 0, attacking);
    expect(queue.mock.calls.map(([path]) => path)).toEqual(
      attacking ? ["sounds/announcer/bomb/offense/inplace.ogg"] : [],
    );
    audio.update(bomb("armed"), 0, attacking);
    audio.update(bomb("armed"), 0, attacking);
    expect(queue.mock.calls.at(-1)?.[0]).toBe(`sounds/announcer/bomb/${attacking ? "offense" : "defense"}/planted.ogg`);
    expect(queue).toHaveBeenCalledTimes(attacking ? 2 : 1);
  });

  it("does not announce an old plant when joining an armed round", () => {
    const announcer = new FPSAnnouncer();
    const queue = vi.spyOn(announcer, "queue").mockImplementation(() => {});
    new FPSBombAudio(announcer).update(bomb("armed"), 0, false);
    expect(queue).not.toHaveBeenCalled();
  });
});
