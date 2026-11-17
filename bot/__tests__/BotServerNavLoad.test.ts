/**
 * A map's nav graph is loaded once however many bots ask, and reaches every bot
 * on the map when it is ready: a build runs away from the bots' event loop, so
 * they play without one meanwhile.
 */

import { describe, expect, it, vi } from "vitest";

const build = vi.hoisted(() => ({ calls: 0, fail: false, release: null as null | (() => void) }));

vi.mock("../BotNavBuilder", () => ({
  buildNavGraph: (mapName: string) => {
    build.calls++;
    if (build.fail) return Promise.resolve(null);
    return new Promise((resolve) => {
      build.release = () =>
        resolve({
          mapName,
          nodeCount: 1,
          edgeCount: 0,
          addLearnedRoutes: () => 0,
          walkTest: () => ({}),
        } as unknown as object);
    });
  },
}));

vi.mock("../BotNavCache", () => ({
  BotNavCacheStore: class {
    lastDiagnostic = "miss";
    load() {
      return null;
    }
  },
}));

vi.mock("../LearnedRoutes", async (original) => ({
  ...(await original<object>()),
  loadLearnedRoutes: () => [],
}));

import { BotServer } from "../BotServer";

// biome-ignore lint/suspicious/noExplicitAny: reaches the server's private loader and bot table
type Inner = any;

function bot(map: string) {
  return { serverInfo: { map }, setNavGraph: vi.fn() };
}

describe("nav graph loading", () => {
  it("builds once for many bots and hands the graph to every bot on the map", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server: Inner = new BotServer(0);
    const here = [bot("washoi_snd1"), bot("washoi_snd1")];
    const elsewhere = bot("washoi_dm2");
    server._bots = new Map([
      ["a", here[0]],
      ["b", here[1]],
      ["c", elsewhere],
    ]);
    const vision = { mapKnowledge: { mapFingerprint: "x" }, isWalkable: () => true };
    const first = server._loadNavGraph("washoi_snd1", vision);
    const second = server._loadNavGraph("washoi_snd1", vision);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(build.calls).toBe(1);
    build.release?.();
    await first;
    for (const b of here) expect(b.setNavGraph).toHaveBeenCalledWith(expect.objectContaining({ nodeCount: 1 }));
    expect(elsewhere.setNavGraph).not.toHaveBeenCalled();
    expect(server._navGraphCache.has("washoi_snd1")).toBe(true);
    vi.restoreAllMocks();
  });

  it("builds a failed graph again for a later bot, a few times at most", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    build.calls = 0;
    build.fail = true;
    const server: Inner = new BotServer(0);
    const vision = { mapKnowledge: { mapFingerprint: "x" }, fork: () => ({}) };
    server._visionCache.set("washoi_dm2", vision);
    await server._loadNavGraph("washoi_dm2", vision);
    expect(build.calls).toBe(1);
    // Bots joining later find the vision cached and no graph: each tries again, up to the limit
    for (let i = 0; i < 4; i++) {
      const next = { serverInfo: { map: "washoi_dm2" }, name: `b${i}`, setVision: vi.fn(), setNavGraph: vi.fn() };
      await server._loadVisionForBot(next);
      await Promise.all([...server._navLoading.values()]);
    }
    expect(build.calls).toBe(3);
    build.fail = false;
    vi.restoreAllMocks();
  });
});
