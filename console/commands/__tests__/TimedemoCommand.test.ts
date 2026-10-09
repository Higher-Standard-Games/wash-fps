import { beforeEach, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  start: vi.fn(() => "started"),
  abort: vi.fn(),
  list: vi.fn(async () => ["wdm2-fixture"]),
  formatReport: vi.fn(() => "report"),
  export: vi.fn(() => "export"),
}));
vi.mock("../../../client/TimedemoService", () => ({ TimedemoService: { getInstance: () => service } }));

import TimedemoCommand from "../TimedemoCommand";

beforeEach(() => vi.clearAllMocks());
it("never substitutes real-time playback for requested fixed-work mode", async () => {
  expect(await new TimedemoCommand().execute(["wdm2-fixture", "--mode", "fixed"])).toContain("Only realtime");
  expect(service.start).not.toHaveBeenCalled();
});
it("runs the requested repeat count and exposes reporting/abort without blocking on the run", async () => {
  const command = new TimedemoCommand();
  expect(await command.execute(["wdm2-fixture", "--repeats", "1"])).toBe("started");
  expect(service.start).toHaveBeenCalledWith("wdm2-fixture", 1);
  expect(await command.execute(["report"])).toBe("report");
  await command.execute(["abort"]);
  expect(service.abort).toHaveBeenCalledOnce();
});
