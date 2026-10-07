import { describe, expect, it } from "vitest";
import { SCENARIOS, time } from "../scenarios";

/**
 * Every scenario has to build and run, and the deterministic ones have to stay deterministic.
 * These do not time anything seriously (the timing options are overridden to be tiny); the numbers
 * come from run.ts.
 */
describe("scenarios", () => {
  it("have unique names and descriptions that say what they leave out", () => {
    const names = SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    for (const scenario of SCENARIOS) {
      expect(scenario.description.length, scenario.name).toBeGreaterThan(40);
      expect(["us per call", "us per tick"]).toContain(scenario.unit);
    }
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name} prepares and runs`, () => {
      const prepared = scenario.prepare();
      expect(Object.keys(prepared.config).length).toBeGreaterThan(0);
      for (let i = 0; i < 5; i++) prepared.run();
      const extras = prepared.extras?.() ?? {};
      for (const value of Object.values(extras)) expect(value).not.toBeNaN();
    });
  }

  it("time() times a scenario with the options it asks for, and returns real numbers", () => {
    const batch = time({ run: () => {}, config: {}, batch: { warmup: 1, iterations: 3, repeats: 4 } });
    expect(batch.samples).toBe(4);
    const each = time({ run: () => {}, config: {}, each: { warmup: 1, iterations: 6 } });
    expect(each.samples).toBe(6);
    expect(each.median).toBeGreaterThanOrEqual(0);
  });

  describe("the 16-player simulation", () => {
    const tick16 = SCENARIOS.find((scenario) => scenario.name === "sim.tick16");

    it("reaches the same final state every time it is run", () => {
      const checksumAfter = (ticks: number): number | string | undefined => {
        const prepared = tick16?.prepare();
        for (let i = 0; i < ticks; i++) prepared?.run();
        return prepared?.checksum?.();
      };
      const first = checksumAfter(60);
      expect(first).toBeDefined();
      expect(checksumAfter(60)).toBe(first);
    });

    it("reaches a different state after a different number of ticks", () => {
      const prepared = tick16?.prepare();
      for (let i = 0; i < 20; i++) prepared?.run();
      const early = prepared?.checksum?.();
      for (let i = 0; i < 20; i++) prepared?.run();
      expect(prepared?.checksum?.()).not.toBe(early);
    });
  });

  it("the snapshot scenarios report a size, and the 16-client one costs a multiple of one encode", () => {
    const find = (name: string) => SCENARIOS.find((scenario) => scenario.name === name)?.prepare();
    const encode = find("snapshot.encode");
    const clients = find("snapshot.encodeClients16");
    encode?.run();
    clients?.run();
    expect(Number(encode?.extras?.().bytesPerSnapshot)).toBeGreaterThan(0);
    expect(Number(clients?.extras?.().bytesAllClients)).toBeGreaterThan(Number(clients?.extras?.().bytesPerClient));
  });

  it("the pickup scenario leaves every pickup where it was, so it measures the scan and nothing else", () => {
    const prepared = SCENARIOS.find((scenario) => scenario.name === "pickups.update")?.prepare();
    // Armor (a quarter of the fixture) starts absent for the first 15 s of a match, which is tick 1875 and
    // this scenario starts at tick 1000. Run past it: anything still inactive after that was taken.
    for (let i = 0; i < 1200; i++) prepared?.run();
    expect(prepared?.config.pickups).toBe(60);
    expect(prepared?.extras?.().inactivePickups).toBe(0);
  });
});
