import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_DOWNLOAD_IDLE_MS, DEMO_DOWNLOAD_TOTAL_MS, downloadDemo } from "../DemoDownload";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const never = (_url: unknown, _options?: RequestInit) => new Promise<Response>(() => {});

describe("bounded demo transfer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles stalled headers even if the transport ignores abort, then permits retry", async () => {
    const fetcher = vi.fn(never);
    vi.stubGlobal("fetch", fetcher);
    const request = downloadDemo("/a", new AbortController().signal);
    const failed = expect(request).rejects.toThrow("stalled");
    await vi.advanceTimersByTimeAsync(DEMO_DOWNLOAD_IDLE_MS);
    await failed;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fetcher.mockImplementation(async () => new Response(new Uint8Array([1, 2])));
    expect(await downloadDemo("/a", new AbortController().signal)).toEqual(new Uint8Array([1, 2]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and cancels a stalled body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    const request = downloadDemo("/a", new AbortController().signal);
    const failed = expect(request).rejects.toThrow("stalled");
    await vi.advanceTimersByTimeAsync(DEMO_DOWNLOAD_IDLE_MS);
    await failed;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews the idle deadline while a slow recording makes progress", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start: (value) => {
                stream = value;
              },
            }),
          ),
      ),
    );
    const request = downloadDemo("/a", new AbortController().signal);
    await flush();
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(DEMO_DOWNLOAD_IDLE_MS - 1000);
      stream.enqueue(new Uint8Array([i]));
      await flush();
    }
    stream.close();
    expect(await request).toEqual(new Uint8Array([1, 2, 3]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still bounds a transfer that continues indefinitely", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start: (value) => {
                stream = value;
              },
            }),
          ),
      ),
    );
    const request = downloadDemo("/a", new AbortController().signal);
    const failed = expect(request).rejects.toThrow("too long");
    await flush();
    for (
      let elapsed = 0;
      elapsed < DEMO_DOWNLOAD_TOTAL_MS - DEMO_DOWNLOAD_IDLE_MS;
      elapsed += DEMO_DOWNLOAD_IDLE_MS - 1000
    ) {
      await vi.advanceTimersByTimeAsync(DEMO_DOWNLOAD_IDLE_MS - 1000);
      stream.enqueue(new Uint8Array([1]));
      await flush();
    }
    await vi.advanceTimersByTimeAsync(DEMO_DOWNLOAD_IDLE_MS);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels promptly and detaches cancellation after a completed transfer", async () => {
    const fetcher = vi.fn(never);
    vi.stubGlobal("fetch", fetcher);
    const cancelled = new AbortController();
    const request = downloadDemo("/a", cancelled.signal);
    const failed = expect(request).rejects.toMatchObject({ name: "AbortError" });
    cancelled.abort();
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    fetcher.mockImplementation(async () => new Response(new Uint8Array([1])));
    const completed = new AbortController();
    await downloadDemo("/b", completed.signal);
    const transportSignal = fetcher.mock.calls[1][1]!.signal!;
    completed.abort();
    expect(transportSignal.aborted).toBe(false);
  });

  it("does not contact the server for a pre-cancelled request and clears HTTP-error deadlines", async () => {
    const fetcher = vi.fn(async () => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(downloadDemo("/a", cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(downloadDemo("/a", new AbortController().signal)).rejects.toThrow("HTTP 404");
    expect(vi.getTimerCount()).toBe(0);
  });
});
