/**
 * Recorded-tick ownership for demo-only HUD/event transients.
 *
 * Entries expire against the demo playhead, so pause freezes them and playback
 * speed changes their wall-clock duration without changing recorded duration.
 * A discontinuity clears old entries and suppresses events on the landing frame.
 */

export type DemoEventKind = "chat" | "kill" | "award" | "banner" | "pickup" | "damage";

export interface DemoEventEntry {
  id: number;
  kind: DemoEventKind;
  text: string;
  endTick: number;
}

export class DemoEventTimeline {
  private playheadTick = 0;
  private tickRate = 60;
  private discontinuityId = -1;
  private suppressStarts = true;
  private nextId = 1;
  private entries: DemoEventEntry[] = [];

  /** @returns true when a seek/restart invalidated transient presentation. */
  setClock(playheadTick: number, tickRate: number, discontinuityId: number): boolean {
    const discontinuous = discontinuityId !== this.discontinuityId;
    if (discontinuous) {
      this.entries = [];
      this.suppressStarts = true;
      this.discontinuityId = discontinuityId;
    }
    this.playheadTick = playheadTick;
    this.tickRate = tickRate > 0 ? tickRate : 60;
    this.expire();
    return discontinuous;
  }

  /** Add a forward-play transient. Returns false on a seek landing frame. */
  push(kind: DemoEventKind, text: string, durationMs: number): boolean {
    if (this.suppressStarts || !text || durationMs <= 0) return false;
    this.entries.push({
      id: this.nextId++,
      kind,
      text,
      endTick: this.playheadTick + (durationMs / 1000) * this.tickRate,
    });
    return true;
  }

  getEntries(): readonly DemoEventEntry[] {
    this.expire();
    return this.entries;
  }

  canPresentOneShots(): boolean {
    return !this.suppressStarts;
  }

  finishPresentationFrame(): void {
    this.suppressStarts = false;
  }

  clear(): void {
    this.entries = [];
    this.suppressStarts = true;
    this.discontinuityId = -1;
  }

  private expire(): void {
    this.entries = this.entries.filter((entry) => this.playheadTick < entry.endTick);
  }
}
