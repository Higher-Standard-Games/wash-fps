/**
 * Recorded-time ownership for transient player-model animations.
 *
 * Babylon still evaluates the animation curves, but this timeline decides
 * whether a one-shot is active and what time scale its group receives. No
 * wall-clock timestamps participate in demo playback.
 */

export interface DemoOneShotState {
  entityId: string;
  animation: string;
  endTick: number;
  baseSpeedRatio: number;
  timeScale: number;
}

interface StoredOneShot {
  entityId: string;
  animation: string;
  endTick: number;
  baseSpeedRatio: number;
}

export class DemoAnimationTimeline {
  private playheadTick = 0;
  private tickRate = 60;
  private playbackSpeed = 1;
  private paused = false;
  private discontinuityId = -1;
  private suppressStarts = true;
  private readonly oneShots = new Map<string, StoredOneShot>();

  /**
   * Update the canonical demo clock.
   * @returns true when a seek/restart invalidated active animation state.
   */
  setClock(
    playheadTick: number,
    tickRate: number,
    playbackSpeed: number,
    paused: boolean,
    discontinuityId: number,
  ): boolean {
    const discontinuous = discontinuityId !== this.discontinuityId;
    if (discontinuous) {
      this.oneShots.clear();
      this.suppressStarts = true;
      this.discontinuityId = discontinuityId;
    }
    this.playheadTick = playheadTick;
    this.tickRate = tickRate > 0 ? tickRate : 60;
    this.playbackSpeed = playbackSpeed;
    this.paused = paused;
    return discontinuous;
  }

  /**
   * Start a forward-play one-shot. Landing frames after a discontinuity are
   * intentionally ignored; finishPresentationFrame() enables later events.
   */
  start(entityId: string, animation: string, durationMs: number, baseSpeedRatio: number): boolean {
    if (this.suppressStarts || durationMs <= 0 || baseSpeedRatio <= 0) return false;
    const durationTicks = (durationMs / 1000) * this.tickRate;
    this.oneShots.set(entityId, {
      entityId,
      animation,
      endTick: this.playheadTick + durationTicks,
      baseSpeedRatio,
    });
    return true;
  }

  get(entityId: string): DemoOneShotState | null {
    const shot = this.oneShots.get(entityId);
    if (!shot) return null;
    if (this.playheadTick >= shot.endTick) {
      this.oneShots.delete(entityId);
      return null;
    }
    return {
      ...shot,
      timeScale: this.paused ? 0 : this.playbackSpeed,
    };
  }

  delete(entityId: string): void {
    this.oneShots.delete(entityId);
  }

  finishPresentationFrame(): void {
    this.suppressStarts = false;
  }

  clear(): void {
    this.oneShots.clear();
    this.suppressStarts = true;
    this.discontinuityId = -1;
  }
}
