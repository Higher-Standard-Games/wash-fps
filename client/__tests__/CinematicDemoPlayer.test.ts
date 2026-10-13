/**
 * CinematicDemoPlayer.test.ts — Unit tests for Phase 4 playback engine
 *
 * Babylon.js is mocked so tests run in Node without a canvas.
 * DemoReader.fromFile and DemoAnalyzer are mocked with minimal stubs so we
 * can test the state machine without real demo data.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock Babylon.js Vector3 ───────────────────────────────────────────────────

vi.mock("@babylonjs/core/Maths/math.vector", () => ({
  Vector3: class MockVector3 {
    x: number;
    y: number;
    z: number;
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    copyFrom(v: { x: number; y: number; z: number }) {
      this.x = v.x;
      this.y = v.y;
      this.z = v.z;
      return this;
    }
  },
}));

// ── Mock DemoReader ───────────────────────────────────────────────────────────

vi.mock("../../../../shared/demo/DemoReader", () => {
  return {
    DemoReader: {
      fromFile: vi.fn().mockResolvedValue({
        readHeader: () => ({
          version: 1,
          map: "q3dm1",
          gametype: "ffa",
          tickRate: 60,
          snapshotRate: 20,
          startTime: 0,
          players: [],
        }),
        readIndex: () => ({
          frameCount: 100,
          durationMs: 5000,
          entries: Array.from({ length: 100 }, (_, i) => ({ tick: i * 3 })),
        }),
        readAllFrames: () => [],
        findFrameByTick: () => 0,
        getSummary: () => "mock demo",
      }),
    },
  };
});

// ── Mock DemoAnalyzer ─────────────────────────────────────────────────────────

vi.mock("../../../../shared/demo/DemoAnalyzer", () => {
  return {
    DemoAnalyzer: vi.fn().mockImplementation(() => ({
      analyze: vi.fn().mockReturnValue({
        highlights: [
          {
            startTick: 10,
            peakTick: 15,
            endTick: 30,
            score: 20,
            type: "frag",
            primaryPlayer: "player_1",
            primaryPlayerName: "Alice",
            victimPlayer: "player_2",
            victimPlayerName: "Bob",
            tags: [],
            killCount: 1,
            killerPos: { x: 0, y: 0, z: 0 },
            victimPos: { x: 100, y: 0, z: 0 },
            killerVelocity: { x: 0, y: 0, z: 0 },
            weaponId: "rocket_launcher",
          },
        ],
        totalTicks: 300,
        totalDurationMs: 15000,
        playerNames: new Map([["player_1", "Alice"]]),
      }),
    })),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockDemoViewer() {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    play: vi.fn(),
    pause: vi.fn(),
    seekToTick: vi.fn(),
    seekToFrame: vi.fn(),
    setSpeed: vi.fn(),
    getInfo: vi.fn().mockReturnValue({
      state: "playing" as const,
      header: null,
      currentFrame: 0,
      totalFrames: 100,
      currentTick: 0,
      playheadTick: 0,
      durationMs: 5000,
      elapsedMs: 0,
      playbackSpeed: 1.0,
    }),
    getState: vi.fn().mockReturnValue("playing"),
    isLoaded: vi.fn().mockReturnValue(true),
    onFrame: vi.fn(),
    onStateChange: vi.fn(),
  };
}

function makeMockFreeCamera() {
  return {
    rotation: { set: vi.fn() },
    fov: 1.0,
  };
}

function makeMockCameraSystem(freeCamera = makeMockFreeCamera()) {
  const controllers = new Map<
    string,
    { setSpectateTarget?: (id: string) => void; setPosition?: (v: unknown) => void }
  >();
  controllers.set("spectator", { setSpectateTarget: vi.fn() });
  controllers.set("freefly", { setPosition: vi.fn() });

  return {
    setController: vi.fn(),
    getController: vi.fn((type: string) => controllers.get(type)),
    getFreeCamera: vi.fn().mockReturnValue(freeCamera),
  };
}

// ── Import SUT after mocks ────────────────────────────────────────────────────
// Vitest hoists vi.mock() calls before imports, so this import sees the mocks.

import { CinematicDemoPlayer, type CinematicPlayerState } from "../CinematicDemoPlayer";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CinematicDemoPlayer", () => {
  let viewer: ReturnType<typeof makeMockDemoViewer>;
  let cameraSystem: ReturnType<typeof makeMockCameraSystem>;
  let player: CinematicDemoPlayer;

  beforeEach(() => {
    viewer = makeMockDemoViewer();
    cameraSystem = makeMockCameraSystem();
    player = new CinematicDemoPlayer(
      viewer as unknown as import("../DemoViewer").DemoViewer,
      cameraSystem as unknown as import("../../../../engine/camera/CameraSystem").CameraSystem,
    );
  });

  // 1. Initial state is 'idle'
  it("starts in idle state", () => {
    expect(player.getState()).toBe("idle");
  });

  // 2. loadAndPlay transitions through analyzing → playing
  it("transitions to playing after loadAndPlay", async () => {
    const states: CinematicPlayerState[] = [];
    player.onStateChange((s) => states.push(s));

    await player.loadAndPlay(new Uint8Array(8), 2);

    expect(states).toContain("analyzing");
    expect(player.getState()).toBe("playing");
  });

  // 3. loadAndPlay calls DemoViewer.load
  it("calls demoViewer.load with the raw data", async () => {
    const data = new Uint8Array([1, 2, 3]);
    await player.loadAndPlay(data, 2);
    expect(viewer.load).toHaveBeenCalledWith(data);
  });

  // 4. loadAndPlay calls seekToTick + setSpeed + play for the first segment
  it("seeks and plays the first segment on loadAndPlay", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    expect(viewer.seekToTick).toHaveBeenCalled();
    expect(viewer.setSpeed).toHaveBeenCalled();
    expect(viewer.play).toHaveBeenCalled();
  });

  // 5. pause() changes state to paused and calls demoViewer.pause
  it("pause() changes state to paused", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    player.pause();
    expect(player.getState()).toBe("paused");
    expect(viewer.pause).toHaveBeenCalled();
  });

  // 6. resume() changes state back to playing and calls demoViewer.play
  it("resume() changes state back to playing", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    player.pause();
    player.resume();
    expect(player.getState()).toBe("playing");
    expect(viewer.play).toHaveBeenCalledTimes(2); // once on load, once on resume
  });

  // 7. pause() is a no-op when not playing
  it("pause() is a no-op when already paused", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    player.pause();
    const pauseCount = (viewer.pause as ReturnType<typeof vi.fn>).mock.calls.length;
    player.pause(); // second call — should be ignored
    expect((viewer.pause as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pauseCount);
  });

  // 8. togglePlayPause toggles correctly
  it("togglePlayPause transitions between playing and paused", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    expect(player.getState()).toBe("playing");
    player.togglePlayPause();
    expect(player.getState()).toBe("paused");
    player.togglePlayPause();
    expect(player.getState()).toBe("playing");
  });

  // 9. update() triggers segment advance when the playhead reaches endTick
  it("advances segment when the playhead reaches endTick", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);

    const reel = (player as unknown as { reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel }).reel!;
    const firstEndTick = reel.segments[0].endTick;

    // Simulate tick reaching end of first segment
    viewer.getInfo.mockReturnValue({
      state: "playing",
      header: null,
      currentFrame: 0,
      totalFrames: 100,
      playheadTick: firstEndTick,
      durationMs: 5000,
      elapsedMs: 0,
      playbackSpeed: 1.0,
    });

    const segChanges: number[] = [];
    player.onSegmentChange((_seg, idx) => segChanges.push(idx));

    player.update(16);

    // If there's a second segment, onSegmentChange fires; otherwise we end
    if (reel.segments.length > 1) {
      expect(segChanges.length).toBeGreaterThan(0);
    } else {
      expect(player.getState()).toBe("ended");
    }
  });

  // 10. reel end fires onReelEnd callback and sets state to ended
  it("fires onReelEnd and sets state to ended when reel is exhausted", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);

    let reelEnded = false;
    player.onReelEnd(() => {
      reelEnded = true;
    });

    const reel = (player as unknown as { reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel }).reel!;

    // Simulate each segment ending in turn
    for (let i = 0; i < reel.segments.length * 2; i++) {
      const lastSeg = reel.segments[reel.segments.length - 1];
      viewer.getInfo.mockReturnValue({
        state: "playing",
        header: null,
        currentFrame: 0,
        totalFrames: 100,
        playheadTick: lastSeg.endTick + 1,
        durationMs: 5000,
        elapsedMs: 0,
        playbackSpeed: 1.0,
      });
      player.update(16);
    }

    expect(player.getState()).toBe("ended");
    expect(reelEnded).toBe(true);
  });

  // 11. nextSegment / prevSegment boundary conditions
  it("prevSegment does not go below segment 0", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    player.prevSegment();
    const info = player.getReelInfo();
    expect(info.currentSegment).toBe(0);
  });

  it("nextSegment clamps to last segment", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    const reel = (player as unknown as { reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel }).reel!;
    const lastIdx = reel.segments.length - 1;

    // Jump well past the end
    for (let i = 0; i <= lastIdx + 5; i++) {
      player.nextSegment();
    }
    const info = player.getReelInfo();
    expect(info.currentSegment).toBeLessThanOrEqual(lastIdx);
  });

  // 12. stop() resets state to idle and clears reel
  it("stop() resets to idle and clears reel", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    player.stop();
    expect(player.getState()).toBe("idle");
    const info = player.getReelInfo();
    expect(info.totalSegments).toBe(0);
    expect(info.reelElapsedMs).toBe(0);
  });

  // 13. getReelInfo reads the reel's position from the playhead
  it("places the reel by the playhead within its shots, and a skip lands on the shot's start", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    const reel = (player as unknown as { reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel }).reel;
    const first = reel.segments[0];
    const middle = (first.startTick + first.endTick) / 2;
    viewer.getInfo.mockReturnValue({ ...viewer.getInfo(), playheadTick: middle });
    expect(player.getReelInfo().reelElapsedMs).toBeCloseTo(first.durationMs / 2);
    expect(player.getShotStarts()[0]).toBe(0);
    if (reel.segments.length < 2) return;
    player.skipToProgress(player.getShotStarts()[1]);
    viewer.getInfo.mockReturnValue({ ...viewer.getInfo(), playheadTick: reel.segments[1].startTick });
    expect(player.getReelInfo()).toMatchObject({ currentSegment: 1, reelElapsedMs: first.durationMs });
  });

  // 14. getReelInfo.reelProgress is between 0 and 1
  it("getReelInfo.reelProgress is clamped to [0, 1]", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    player.update(999999); // huge delta
    const info = player.getReelInfo();
    expect(info.reelProgress).toBeGreaterThanOrEqual(0);
    expect(info.reelProgress).toBeLessThanOrEqual(1);
  });

  // 15. setController called with 'spectator' or 'freefly' during segment apply
  it("sets camera controller when applying a segment", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    expect(cameraSystem.setController).toHaveBeenCalled();
    const calls = (cameraSystem.setController as ReturnType<typeof vi.fn>).mock.calls;
    const controllerTypes = calls.map((c: string[]) => c[0]);
    const validTypes = ["spectator", "freefly"];
    for (const t of controllerTypes) {
      expect(validTypes).toContain(t);
    }
  });

  // 16. onSegmentChange fires with correct segment index on loadAndPlay
  it("fires onSegmentChange with index 0 on initial playback start", async () => {
    const changes: number[] = [];
    player.onSegmentChange((_seg, idx) => changes.push(idx));
    await player.loadAndPlay(new Uint8Array(8), 2);
    expect(changes[0]).toBe(0);
  });

  // 17. update() is a no-op when paused
  it("update() does not advance elapsed time when paused", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    player.pause();
    player.update(1000);
    const info = player.getReelInfo();
    expect(info.reelElapsedMs).toBe(0);
  });

  // 18. skipToSegment with valid index re-seeks DemoViewer
  it("skipToSegment re-seeks the DemoViewer to the target segment's startTick", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    const seekCallsBefore = (viewer.seekToTick as ReturnType<typeof vi.fn>).mock.calls.length;
    player.skipToSegment(0);
    const seekCallsAfter = (viewer.seekToTick as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(seekCallsAfter).toBeGreaterThan(seekCallsBefore);
  });

  // 19. speed keyframes applied during update()
  it("watches the victim up to the frag, the killer after it, and whoever is present", async () => {
    const present = new Set(["player_1", "player_2"]);
    player = new CinematicDemoPlayer(
      viewer as unknown as import("../DemoViewer").DemoViewer,
      cameraSystem as unknown as import("../../../../engine/camera/CameraSystem").CameraSystem,
      { positionOf: (id) => (present.has(id) ? { x: 0, y: 0, z: 0 } : null), blockedAt: () => null },
    );
    await player.loadAndPlay(new Uint8Array(8), 2);
    const internals = player as unknown as {
      reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel;
      cameraPaths: Array<{ type: string; targetEntityId?: string }>;
    };
    const seg = internals.reel.segments[0];
    seg.cameraPreset = "victim_pov";
    seg.cameraTarget = "player_2";
    internals.cameraPaths[seg.segmentIndex] = { type: "chase", targetEntityId: "player_2" };
    const spectator = cameraSystem.getController("spectator") as { setSpectateTarget: ReturnType<typeof vi.fn> };
    const at = (playheadTick: number) => {
      viewer.getInfo.mockReturnValue({ ...viewer.getInfo(), playheadTick });
      player.update(16);
      return spectator.setSpectateTarget.mock.calls.at(-1)?.[0];
    };
    expect(at(seg.highlight.peakTick - 1)).toBe("player_2");
    expect(at(seg.highlight.peakTick)).toBe("player_1");
    present.delete("player_1");
    expect(at(seg.highlight.peakTick + 1)).toBe("player_2");
  });

  it("aims a fly-by at the players and keeps it in front of a wall between them", async () => {
    let wall: { x: number; y: number; z: number } | null = null;
    player = new CinematicDemoPlayer(
      viewer as unknown as import("../DemoViewer").DemoViewer,
      cameraSystem as unknown as import("../../../../engine/camera/CameraSystem").CameraSystem,
      {
        positionOf: (id) =>
          id === "player_1" ? { x: 0, y: 0, z: 0 } : id === "player_2" ? { x: 100, y: 0, z: 0 } : null,
        blockedAt: () => wall,
      },
    );
    await player.loadAndPlay(new Uint8Array(8), 2);
    const internals = player as unknown as {
      reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel;
      _frameFlyby(
        segment: import("../../../../shared/demo/SequenceBuilder").CinematicSegment,
        pos: { x: number; y: number; z: number },
        look: { x: number; y: number; z: number },
        deltaMs: number,
      ): { position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } };
    };
    const shot = internals.reel.segments[0];
    // First frame: straight to the plan's spot, looking between the two at chest height.
    const first = internals._frameFlyby(shot, { x: 50, y: 0, z: 400 }, { x: 999, y: 999, z: 999 }, 16);
    expect(first.lookAt).toEqual({ x: 50, y: 12, z: 0 });
    expect(first.position).toEqual({ x: 50, y: 0, z: 400 });
    // A wall at z 200 comes between: the camera eases in toward its near side.
    wall = { x: 50, y: 6, z: 200 };
    let framed = first;
    for (let i = 0; i < 120; i++) framed = internals._frameFlyby(shot, { x: 50, y: 0, z: 400 }, first.lookAt, 16);
    expect(framed.position.z).toBeLessThan(200);
    expect(framed.position.z).toBeGreaterThan(150);
  });

  it("draws a shot's way in and way out as a veil over the picture", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    const reel = (player as unknown as { reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel }).reel;
    const shot = reel.segments[0];
    shot.transitionIn = "fade_to_black";
    shot.transitionOut = "cut";
    shot.speedKeyframes = undefined;
    viewer.getInfo.mockReturnValue({ ...viewer.getInfo(), playheadTick: shot.startTick });
    expect(player.getVeil()).toEqual({ color: "black", opacity: 1 });
    player.update(shot.transitionDurationMs / 2);
    expect(player.getVeil().opacity).toBeCloseTo(0.5);
    player.update(shot.transitionDurationMs);
    expect(player.getVeil().opacity).toBe(0);
    // The flash rises over the shot's last moments, into the replay after it.
    shot.transitionOut = "white_flash";
    viewer.getInfo.mockReturnValue({ ...viewer.getInfo(), playheadTick: shot.endTick - 0.001 });
    expect(player.getVeil()).toMatchObject({ color: "white" });
    expect(player.getVeil().opacity).toBeGreaterThan(0.8);
  });

  it("eases into a speed keyframe instead of snapping to it", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);

    const reel = (player as unknown as { reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel }).reel!;
    const seg = reel.segments[0];

    // Only meaningful if the segment has speedKeyframes
    if (!seg.speedKeyframes?.length) return;

    const kf = seg.speedKeyframes[0];
    viewer.getInfo.mockReturnValue({
      state: "playing",
      header: null,
      currentFrame: 0,
      totalFrames: 100,
      playheadTick: kf.tick,
      durationMs: 5000,
      elapsedMs: 0,
      playbackSpeed: 1.0,
    });

    vi.clearAllMocks();
    viewer.getInfo.mockReturnValue({
      state: "playing",
      header: null,
      currentFrame: 0,
      totalFrames: 100,
      playheadTick: kf.tick,
      durationMs: 5000,
      elapsedMs: 0,
      playbackSpeed: 1.0,
    });

    player.update(16);
    const first = viewer.setSpeed.mock.calls.at(-1)?.[0] as number;
    expect(first).not.toBe(kf.speed);
    expect(Math.abs(first - kf.speed)).toBeLessThan(Math.abs(seg.playbackSpeed - kf.speed));
    for (let i = 0; i < 60; i++) player.update(16);
    expect(viewer.setSpeed).toHaveBeenLastCalledWith(kf.speed);
  });
  it("stops on the reel's last shot instead of playing on unedited", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    const reel = (player as unknown as { reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel }).reel!;
    const lastSeg = reel.segments[reel.segments.length - 1];
    viewer.getInfo.mockReturnValue({ ...viewer.getInfo(), playheadTick: lastSeg.endTick + 1 });
    for (let i = 0; i < reel.segments.length; i++) player.update(16);

    expect(player.getState()).toBe("ended");
    // The viewer kept running from wherever the last highlight ended, under a
    // camera nothing drove any more (D6).
    expect(viewer.pause).toHaveBeenCalled();
    expect(viewer.pause.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(viewer.play.mock.invocationCallOrder.at(-1)!);
  });

  it("aims and zooms a flyby through the free-fly controller's own camera", async () => {
    await player.loadAndPlay(new Uint8Array(8), 2);
    const reel = (player as unknown as { reel: import("../../../../shared/demo/SequenceBuilder").CinematicReel }).reel!;
    const seg = reel.segments[0];
    const paths = (
      player as unknown as { cameraPaths: import("../../../../shared/demo/CinematicCameraPaths").CameraPathResult[] }
    ).cameraPaths;
    paths[seg.segmentIndex] = {
      type: "freefly",
      keyframes: [{ tick: seg.startTick, position: { x: 0, y: 0, z: 0 }, lookAt: { x: 100, y: 0, z: 0 }, fov: 60 }],
    } as import("../../../../shared/demo/CinematicCameraPaths").CameraPathResult;
    // In the game the camera system's camera is an ArcRotateCamera: no free camera.
    cameraSystem.getFreeCamera.mockReturnValue(null);
    const flyCam = makeMockFreeCamera();
    const freefly = cameraSystem.getController("freefly") as Record<string, unknown>;
    freefly.getCamera = () => flyCam;
    viewer.getInfo.mockReturnValue({ ...viewer.getInfo(), playheadTick: seg.startTick });

    player.update(16);

    expect(flyCam.rotation.set).toHaveBeenCalledWith(-0, Math.PI / 2, 0);
    expect(flyCam.fov).toBeCloseTo(Math.PI / 3);
  });
});
