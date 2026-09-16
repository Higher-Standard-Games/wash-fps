/**
 * ClientSilenceMonitor — names a connected client whose messages have stopped.
 *
 * A playing client sends an input every tick and acknowledges every snapshot, so
 * a couple of seconds without any message means its traffic is not arriving, even
 * while its connection stays open and no error or close is seen. Each client is
 * reported once when it goes silent and once when it is heard from again.
 */

export interface SilenceChange {
  /** Connection id. */
  id: string;
  /** How long the client had been silent, in ms. */
  silentMs: number;
}

export class ClientSilenceMonitor {
  /** Connection id → its last message time when the silence was reported. */
  private readonly silent = new Map<string, number>();

  constructor(readonly warnAfterMs = 2000) {}

  /** Connections that newly went silent, and silent ones heard from again, as of `now`. */
  check(
    connections: Iterable<{ id: string; lastMessageAt: number }>,
    now: number,
  ): { stalled: SilenceChange[]; resumed: SilenceChange[] } {
    const stalled: SilenceChange[] = [];
    const resumed: SilenceChange[] = [];
    const present = new Set<string>();

    for (const { id, lastMessageAt } of connections) {
      present.add(id);
      const reportedAt = this.silent.get(id);
      if (reportedAt !== undefined) {
        if (lastMessageAt > reportedAt) {
          resumed.push({ id, silentMs: lastMessageAt - reportedAt });
          this.silent.delete(id);
        }
        continue;
      }
      const silentMs = now - lastMessageAt;
      if (silentMs >= this.warnAfterMs) {
        stalled.push({ id, silentMs });
        this.silent.set(id, lastMessageAt);
      }
    }

    // A connection that left is no longer silent, and its id may be reused.
    for (const id of this.silent.keys()) {
      if (!present.has(id)) this.silent.delete(id);
    }
    return { stalled, resumed };
  }
}
