/** A highlight reel's ceiling; a full match passes its own. */
const DEFAULT_MAX_BYTES = 768 * 1024 * 1024;
const FILE_NAME = /^[0-9a-f-]{36}\.mp4$/;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

/** A crashed document releases its lock; another tab must not delete a live result. */
async function holdFile(name: string, ifAvailable = false): Promise<(() => Promise<void>) | null> {
  if (!navigator.locks) throw new Error("This browser cannot protect a temporary video file");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: (acquired: boolean) => void;
  let failed!: (error: unknown) => void;
  const acquired = new Promise<boolean>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const completed = navigator.locks.request(`washoi-video-export:${name}`, { ifAvailable }, async (lock) => {
    ready(!!lock);
    if (lock) await held;
  });
  // Observe failures immediately, including while acquisition is still pending.
  const settled = completed.then(
    () => {},
    (error) => {
      failed(error);
    },
  );
  if (!(await acquired)) return null;
  return async () => {
    release();
    await settled;
  };
}

async function removeOrphans(directory: FileSystemDirectoryHandle): Promise<void> {
  const iterable = directory as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  let visited = 0;
  for await (const [name, entry] of iterable.entries()) {
    if (++visited > 128) break;
    if (entry.kind !== "file" || !FILE_NAME.test(name)) continue;
    const release = await holdFile(name, true);
    if (!release) continue;
    try {
      const file = await (await directory.getFileHandle(name)).getFile();
      if (Date.now() - file.lastModified > ORPHAN_AGE_MS) await directory.removeEntry(name);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    } finally {
      await release();
    }
  }
}

/** One job's encoded file; never stores raw frames or a whole-file memory buffer. */
export class TemporaryVideo {
  private closed = false;
  private finalized = false;
  private disposed = false;
  private disposing: Promise<void> | null = null;
  bytes = 0;
  readonly stream: WritableStream<{ type: "write"; position: number; data: Uint8Array<ArrayBuffer> }>;

  private constructor(
    private readonly directory: FileSystemDirectoryHandle,
    private readonly name: string,
    private readonly handle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
    private readonly release: () => Promise<void>,
    maxBytes: number,
  ) {
    this.stream = new WritableStream({
      write: async (chunk) => {
        const end = chunk.position + chunk.data.byteLength;
        if (!Number.isSafeInteger(end) || chunk.position < 0 || end > maxBytes)
          throw new Error("The encoded video exceeds the temporary-file limit");
        await writable.write(chunk);
        this.bytes = Math.max(this.bytes, end);
      },
      close: async () => {
        await writable.close();
        this.closed = true;
      },
      abort: async () => {
        await writable.abort();
        this.closed = true;
      },
    });
  }

  static async create(expectedBytes: number, maxBytes = DEFAULT_MAX_BYTES): Promise<TemporaryVideo> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid temporary-file limit");
    if (!navigator.storage?.getDirectory) throw new Error("This browser cannot store a temporary video file");
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("washoi-video-export", { create: true });
    await removeOrphans(directory);
    const estimate = await navigator.storage.estimate();
    if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < expectedBytes)
      throw new Error("There is not enough browser storage for this video");
    const name = `${crypto.randomUUID()}.mp4`;
    const release = (await holdFile(name))!;
    try {
      const handle = await directory.getFileHandle(name, { create: true });
      return new TemporaryVideo(directory, name, handle, await handle.createWritable(), release, maxBytes);
    } catch (error) {
      try {
        await directory.removeEntry(name);
      } catch {}
      await release();
      throw error;
    }
  }

  finish(): void {
    if (this.disposed || this.disposing) throw new Error("The video has been discarded");
    if (!this.closed) throw new Error("The muxer has not closed its output");
    this.finalized = true;
  }

  async file(): Promise<File> {
    if (!this.finalized || this.disposing) throw new Error("The video is not finalized");
    return this.handle.getFile();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.disposing) return this.disposing;
    const removing = this.remove();
    this.disposing = removing;
    try {
      await removing;
    } finally {
      if (this.disposing === removing) this.disposing = null;
    }
  }

  private async remove(): Promise<void> {
    const errors: unknown[] = [];
    if (!this.closed) {
      try {
        await this.writable.abort();
        this.closed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    let removed = false;
    try {
      await this.directory.removeEntry(this.name);
      removed = true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") removed = true;
      else errors.push(error);
    }
    if (removed) {
      this.finalized = false;
      this.disposed = true;
      await this.release();
      return;
    }
    // A finished result remains readable and leased after a transient deletion failure.
    if (!this.finalized) await this.release();
    if (errors.length) throw new Error(`Could not release the temporary video: ${errors.map(String).join("; ")}`);
  }
}
