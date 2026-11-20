/**
 * Rough latency from this browser to a region's lobby, as washoi.net's /play
 * page measures it.
 *
 * The lobby has no HTTP health endpoint, so this times a WebSocket opening and
 * closes it without sending anything. An opening costs more than one round
 * trip (TCP, TLS, upgrade), so it overstates in-game ping, but it compares
 * regions fairly. Best of three, one after another, so the first connection's
 * DNS lookup does not count against a region.
 */

const ATTEMPTS = 3;
const TIMEOUT_MS = 4000;

export type PingResult = { status: "ok"; ms: number } | { status: "unreachable" };

/** Milliseconds to a WebSocket `open`, or null on an error or timeout. */
function probe(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve(null);
      return;
    }
    const done = (ms: number | null) => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Already closing
      }
      resolve(ms);
    };
    const timer = setTimeout(() => done(null), TIMEOUT_MS);
    socket.onopen = () => done(Math.round(performance.now() - started));
    socket.onerror = () => done(null);
  });
}

export async function pingLobby(url: string, stillWanted: () => boolean = () => true): Promise<PingResult> {
  let best: number | null = null;
  for (let attempt = 0; attempt < ATTEMPTS && stillWanted(); attempt++) {
    const ms = await probe(url);
    if (ms !== null && (best === null || ms < best)) best = ms;
  }
  return best === null ? { status: "unreachable" } : { status: "ok", ms: best };
}
