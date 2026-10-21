import { describe, expect, it } from "vitest";
import { demoKeyAction, fragSeekTick } from "../DemoPlaybackKeys";

const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({
  code,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...extra,
});
const demo = { reel: false, freeCamera: false };
const reel = { reel: true, freeCamera: false };

describe("demo playback keys", () => {
  it("plays and pauses on Space, in a demo and in a reel", () => {
    expect(demoKeyAction(key("Space"), demo)).toEqual({ type: "toggle_pause" });
    expect(demoKeyAction(key("Space"), reel)).toEqual({ type: "toggle_pause" });
  });

  it("seeks, steps, changes speed, jumps between frags and players in a demo", () => {
    expect(demoKeyAction(key("ArrowLeft"), demo)).toEqual({ type: "seek", seconds: -5 });
    expect(demoKeyAction(key("ArrowRight"), demo)).toEqual({ type: "seek", seconds: 5 });
    expect(demoKeyAction(key("Comma"), demo)).toEqual({ type: "frame", step: -1 });
    expect(demoKeyAction(key("Period"), demo)).toEqual({ type: "frame", step: 1 });
    expect(demoKeyAction(key("ArrowUp"), demo)).toEqual({ type: "speed", step: 1 });
    expect(demoKeyAction(key("ArrowDown"), demo)).toEqual({ type: "speed", step: -1 });
    expect(demoKeyAction(key("KeyN"), demo)).toEqual({ type: "frag", step: 1 });
    expect(demoKeyAction(key("KeyP"), demo)).toEqual({ type: "frag", step: -1 });
    expect(demoKeyAction(key("Tab"), demo)).toEqual({ type: "player", step: 1 });
    expect(demoKeyAction(key("Tab", { shiftKey: true }), demo)).toEqual({ type: "player", step: -1 });
    expect(demoKeyAction(key("Digit3"), demo)).toEqual({ type: "player_at", index: 2 });
  });

  it("moves between shots with the arrows in a reel, and leaves the demo-only keys alone", () => {
    expect(demoKeyAction(key("ArrowLeft"), reel)).toEqual({ type: "shot", step: -1 });
    expect(demoKeyAction(key("ArrowRight"), reel)).toEqual({ type: "shot", step: 1 });
    for (const code of ["KeyN", "Tab", "Digit1", "Comma", "ArrowUp"]) expect(demoKeyAction(key(code), reel)).toBeNull();
  });

  it("leaves the movement keys to a free-flying camera, and shortcuts with a modifier alone", () => {
    const free = { reel: false, freeCamera: true };
    expect(demoKeyAction(key("Space"), free)).toBeNull();
    expect(demoKeyAction(key("ArrowLeft"), free)).toBeNull();
    expect(demoKeyAction(key("KeyN"), free)).toEqual({ type: "frag", step: 1 });
    expect(demoKeyAction(key("KeyN", { metaKey: true }), demo)).toBeNull();
    expect(demoKeyAction(key("Digit0"), demo)).toBeNull();
  });
});

describe("frag keys", () => {
  const frags = [1000, 600, 2000];
  it("lands two seconds before the next or previous frag, and moves on when pressed again", () => {
    expect(fragSeekTick(frags, 0, 1, 60)).toBe(480);
    expect(fragSeekTick(frags, 480, 1, 60)).toBe(880);
    expect(fragSeekTick(frags, 880, -1, 60)).toBe(480);
    expect(fragSeekTick(frags, 3000, -1, 60)).toBe(1880);
    expect(fragSeekTick(frags, 1880, 1, 60)).toBeNull();
    expect(fragSeekTick([], 0, 1, 60)).toBeNull();
  });
});

describe("speed keys", () => {
  it("step one preset at a time and stop at either end", async () => {
    const { DemoViewer } = await import("../DemoViewer");
    const viewer = new DemoViewer();
    expect(viewer.stepSpeed(1)).toBe(2);
    expect(viewer.stepSpeed(1)).toBe(4);
    expect(viewer.stepSpeed(1)).toBe(4);
    viewer.setSpeed(0.3);
    expect(viewer.stepSpeed(-1)).toBe(0.25);
    expect(viewer.stepSpeed(-1)).toBe(0.25);
  });
});
