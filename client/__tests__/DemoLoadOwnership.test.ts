import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameState } from "../../../../engine/network/core/GameState";
import { DemoReader } from "../../../../shared/demo/DemoReader";
import { DemoRecorder } from "../../server/DemoRecorder";
import { DemoService } from "../DemoService";

function recording(map: string): Uint8Array<ArrayBuffer> {
  const recorder = new DemoRecorder({ map, gametype: "ffa", tickRate: 125, snapshotRate: 60 });
  const frame = new GameState();
  frame.tick = 1;
  recorder.recordFrame(frame);
  return new Uint8Array(Reflect.get(recorder, "_buildDemoBuffer").call(recorder, 1000));
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const service = DemoService.getInstance();

describe("demo source ownership", () => {
  beforeEach(() => {
    service.stopForLiveGame();
    service.loadedDemoData = null;
    service.loadedDemoReader = null;
  });
  afterEach(() => {
    service.stopForLiveGame();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the newer recording when reversed fetch responses ignore cancellation", async () => {
    const responses = new Map<string, (response: Response) => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => new Promise<Response>((resolve) => responses.set(url, resolve))),
    );
    const first = service.fetchAndLoad("a");
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = service.fetchAndLoad("b");
    responses.get("/data/demos/b")!(new Response(recording("wdm7")));
    await second;
    responses.get("/data/demos/a")!(new Response(recording("wdm2")));
    await cancelled;
    expect(service.loadedDemoReader!.readHeader().map).toBe("wdm7");
  });

  it("cannot commit an old recording after asynchronous parsing finishes late", async () => {
    const a = recording("wdm2");
    const parsed = await DemoReader.fromFile(a);
    let complete!: (reader: DemoReader) => void;
    vi.spyOn(DemoReader, "fromFile").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(a)),
    );
    const first = service.fetchAndLoad("a");
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(complete).toBeTypeOf("function");
    await service.loadRaw(recording("wdm7"));
    complete(parsed);
    await cancelled;
    expect(service.loadedDemoReader!.readHeader().map).toBe("wdm7");
  });

  it.each(["cancel", "live game", "stop"])("does not load a late response after %s", async (action) => {
    const stopPlayback = vi
      .spyOn(service as unknown as { stopPlayback(): void }, "stopPlayback")
      .mockImplementation(() => {});
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const pending = service.fetchAndLoad("a", { signal: controller.signal });
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    if (action === "cancel") controller.abort();
    else if (action === "live game") service.stopForLiveGame();
    else service.stopAll();
    complete(new Response(recording("wdm2")));
    await cancelled;
    expect(service.loadedDemoData).toBeNull();
    if (action === "stop") expect(stopPlayback).toHaveBeenCalledOnce();
  });

  it("preserves the loaded recording when a file has a valid header but a corrupt index", async () => {
    const previous = recording("wdm7");
    await service.loadRaw(previous);
    const invalid = recording("wdm2");
    new DataView(invalid.buffer, invalid.byteOffset, invalid.byteLength).setUint32(
      invalid.byteLength - 4,
      invalid.byteLength,
      true,
    );
    await expect(service.loadRaw(invalid)).rejects.toThrow("Invalid demo index offset");
    expect(service.loadedDemoData).toBe(previous);
    expect(service.loadedDemoReader!.readHeader().map).toBe("wdm7");
  });
});
