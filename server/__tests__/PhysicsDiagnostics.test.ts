import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordedCmd, ReSimSpawn } from "../ReSim";

/**
 * The movement subsystem can print one line per player per second, for debugging. It used to do
 * so on every server; it now does so only when SHAG_DEBUG includes phys.
 */
const spawns: ReSimSpawn[] = [
  { entityId: 1, playerId: 1, x: 0, y: 500, z: 0 },
  { entityId: 2, playerId: 2, x: 64, y: 500, z: 0 },
];
const log: RecordedCmd[] = [];

/** Run 130 ticks, which includes two one-second boundaries (ticks 0 and 125), and return what was printed. */
async function printedWhileRunning(): Promise<string[]> {
  vi.resetModules();
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
  const { createFullResim } = await import("../ReSim");
  const run = createFullResim(spawns, log);
  for (let tick = 0; tick < 130; tick++) run.step(tick);
  return printed;
}

describe("per-second physics diagnostics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("print nothing by default", async () => {
    vi.stubEnv("SHAG_DEBUG", "");
    const printed = await printedWhileRunning();
    expect(printed.filter((line) => line.includes("[PHYS]"))).toEqual([]);
  });

  it("print one line per player per second when SHAG_DEBUG includes phys", async () => {
    vi.stubEnv("SHAG_DEBUG", "phys");
    const printed = await printedWhileRunning();
    const lines = printed.filter((line) => line.includes("[PHYS]"));
    // Two players, at the two boundaries (ticks 0 and 125).
    expect(lines).toHaveLength(4);
    expect(lines.filter((line) => line.includes("eid=1"))).toHaveLength(2);
    expect(lines.filter((line) => line.includes("eid=2"))).toHaveLength(2);
  });
});
