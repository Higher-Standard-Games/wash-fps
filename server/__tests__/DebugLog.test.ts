import { afterEach, describe, expect, it, vi } from "vitest";

/** The server prints diagnostics only for topics named in SHAG_DEBUG. */
async function load(env: string) {
  vi.resetModules();
  vi.stubEnv("SHAG_DEBUG", env);
  return import("../DebugLog");
}

describe("SHAG_DEBUG topics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("enables nothing when unset or empty", async () => {
    const { debugEnabled } = await load("");
    expect(debugEnabled("phys")).toBe(false);
    expect(debugEnabled("kb")).toBe(false);
  });

  it("enables only the listed topics, ignoring spaces", async () => {
    const { debugEnabled } = await load(" phys , kb");
    expect(debugEnabled("phys")).toBe(true);
    expect(debugEnabled("kb")).toBe(true);
    expect(debugEnabled("perf")).toBe(false);
  });

  it("'all' enables every topic", async () => {
    const { debugEnabled } = await load("all");
    expect(debugEnabled("falldamage")).toBe(true);
    expect(debugEnabled("input")).toBe(true);
  });

  it("does not even build the message for a topic that is off", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const { debugLog } = await load("kb");
    const message = vi.fn(() => "hello");
    debugLog("perf", message);
    expect(message).not.toHaveBeenCalled();
    debugLog("kb", message);
    expect(print).toHaveBeenCalledWith("hello");
  });
});
