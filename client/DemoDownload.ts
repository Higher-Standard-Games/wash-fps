/** File transfers need a longer deadline than the demo archive's metadata. */
export const DEMO_DOWNLOAD_IDLE_MS = 60_000;
export const DEMO_DOWNLOAD_TOTAL_MS = 15 * 60_000;

export function demoLoadCancelled(): DOMException {
  return new DOMException("Demo loading cancelled", "AbortError");
}

/** Bound headers and body reads, renewing the idle deadline on each chunk. */
export async function downloadDemo(url: string, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw demoLoadCancelled();
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout>;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  const cancel = () => controller.abort(demoLoadCancelled());
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const renewIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error("The demo download stalled. Please try again.")),
      DEMO_DOWNLOAD_IDLE_MS,
    );
  };
  renewIdle();
  const totalTimer = setTimeout(
    () => controller.abort(new Error("The demo download took too long. Please try again.")),
    DEMO_DOWNLOAD_TOTAL_MS,
  );
  let abortListener: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abortListener, { once: true });
    if (controller.signal.aborted) abortListener();
  });
  // Also settle when a mock/transport fails to honor AbortSignal itself.
  const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, aborted]);
  try {
    const response = await wait(fetch(url, { signal: controller.signal }));
    if (!response.ok) throw new Error(`Could not download the recording (HTTP ${response.status}). Please try again.`);
    renewIdle();
    let data: Uint8Array;
    if (response.body) {
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await wait(reader.read());
        if (chunk.done) break;
        if (chunk.value.byteLength > 0) {
          chunks.push(chunk.value);
          length += chunk.value.byteLength;
          renewIdle();
        }
      }
      data = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      data = new Uint8Array(await wait(response.arrayBuffer()));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    completed = true;
    return data;
  } catch (error) {
    // Some transports reject abort with their own AbortError. Preserve the
    // watchdog's useful explanation instead of treating a timeout as Cancel.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(idleTimer!);
    clearTimeout(totalTimer);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abortListener!);
    if (!completed) {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    } else {
      reader?.releaseLock();
    }
  }
}
