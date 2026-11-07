import { afterEach, describe, expect, it, vi } from "vitest";
import { TemporaryVideo } from "../TemporaryVideo";

afterEach(() => vi.unstubAllGlobals());

function storage(quota = 1_000_000) {
  const files = new Map<string, { lastModified: number }>();
  const write = vi.fn(async () => {}),
    close = vi.fn(async () => {}),
    abort = vi.fn(async () => {});
  const directory = {
    async *entries() {
      for (const name of files.keys()) yield [name, { kind: "file" }];
    },
    getFileHandle: vi.fn(async (name: string) => {
      if (!files.has(name)) files.set(name, { lastModified: Date.now() });
      return { createWritable: async () => ({ write, close, abort }), getFile: async () => files.get(name) };
    }),
    removeEntry: vi.fn(async (name: string) => {
      files.delete(name);
    }),
  };
  const held = new Set<string>();
  vi.stubGlobal("navigator", {
    storage: {
      estimate: async () => ({ quota, usage: 0 }),
      getDirectory: async () => ({ getDirectoryHandle: async () => directory }),
    },
    locks: {
      request: async (
        name: string,
        options: { ifAvailable: boolean },
        callback: (lock: object | null) => Promise<void>,
      ) => {
        if (held.has(name) && options.ifAvailable) return callback(null);
        held.add(name);
        try {
          await callback({});
        } finally {
          held.delete(name);
        }
      },
    },
  });
  return { files, write, close, abort, directory, held };
}

describe("export temporary-file ownership", () => {
  it("requires finalization, streams positional writes, and releases exactly once", async () => {
    const f = storage();
    const video = await TemporaryVideo.create(100);
    await expect(video.file()).rejects.toThrow("not finalized");
    const writer = video.stream.getWriter();
    await writer.write({ type: "write", position: 10, data: new Uint8Array(20) });
    expect(video.bytes).toBe(30);
    await writer.close();
    video.finish();
    expect(await video.file()).toBeDefined();
    await Promise.all([video.dispose(), video.dispose()]);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.directory.removeEntry).toHaveBeenCalledTimes(1);
    expect(f.held.size).toBe(0);
  });

  it("removes old crashed jobs while preserving a locked result and recent files", async () => {
    const f = storage();
    const names = [1, 2, 3].map((n) => `${String(n).repeat(36)}.mp4`);
    f.files.set(names[0], { lastModified: 0 });
    f.files.set(names[1], { lastModified: 0 });
    f.files.set(names[2], { lastModified: Date.now() });
    f.files.set("package-cache", { lastModified: 0 });
    f.held.add(`washoi-video-export:${names[1]}`);
    const video = await TemporaryVideo.create(100);
    expect(f.files.has(names[0])).toBe(false);
    expect(f.files.has(names[1])).toBe(true);
    expect(f.files.has(names[2])).toBe(true);
    expect(f.files.has("package-cache")).toBe(true);
    await video.dispose();
    expect(f.abort).toHaveBeenCalledTimes(1);
  });

  it("rejects insufficient quota before creating a file", async () => {
    const f = storage(50);
    await expect(TemporaryVideo.create(100)).rejects.toThrow("not enough browser storage");
    expect(f.directory.getFileHandle).not.toHaveBeenCalled();
  });

  it("retains a finalized file and its lease after transient deletion failure, then retries", async () => {
    const f = storage();
    const video = await TemporaryVideo.create(100);
    await video.stream.getWriter().close();
    video.finish();
    f.directory.removeEntry.mockRejectedValueOnce(new DOMException("File still in use", "NoModificationAllowedError"));
    await expect(video.dispose()).rejects.toThrow("File still in use");
    expect(await video.file()).toBeDefined();
    expect(f.held.size).toBe(1);
    await video.dispose();
    expect(f.directory.removeEntry).toHaveBeenCalledTimes(2);
    expect(f.held.size).toBe(0);
    await expect(video.file()).rejects.toThrow("not finalized");
    expect(() => video.finish()).toThrow("discarded");
  });
});
