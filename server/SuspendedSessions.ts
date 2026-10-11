/**
 * SuspendedSessions — seats kept for clients whose connection dropped.
 *
 * A player whose link dies mid-match loses everything the moment their socket
 * closes: entity, score, weapons and slot. Most drops are brief — a stalled
 * connection the client gives up on and reopens — so the record is kept here
 * instead, and a client presenting its resume token takes the same seat back.
 *
 * Only the record is held. Its entity stays in the world, standing still and
 * still hittable, exactly as it would while the client was frozen. Once the
 * grace passes the session expires and its owner leaves for good.
 */

export interface SuspendedSession<T> {
  client: T;
  /** When the connection dropped. */
  suspendedAt: number;
}

export class SuspendedSessions<T extends { resumeToken: string }> {
  private readonly sessions = new Map<string, SuspendedSession<T>>();

  /** @param graceMs How long a dropped client may take to come back. */
  constructor(readonly graceMs = 20000) {}

  /** Hold a dropped client's seat. */
  suspend(client: T, now: number): void {
    this.sessions.set(client.resumeToken, { client, suspendedAt: now });
  }

  /** Give the seat back to whoever presents its token; each token works once. */
  take(token: string, now = Date.now()): T | undefined {
    const session = this.sessions.get(token);
    // Keep expired records for expired() to perform authoritative departure cleanup.
    if (!session || now - session.suspendedAt >= this.graceMs) return undefined;
    this.sessions.delete(token);
    return session.client;
  }

  /** Sessions whose grace has run out, removed as they are returned. */
  expired(now: number): T[] {
    const gone: T[] = [];
    for (const [token, session] of this.sessions) {
      if (now - session.suspendedAt < this.graceMs) continue;
      this.sessions.delete(token);
      gone.push(session.client);
    }
    return gone;
  }

  /** Everyone currently holding a seat: they still count as present on the server. */
  clients(): T[] {
    return [...this.sessions.values()].map((session) => session.client);
  }

  get size(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }
}
