/**
 * Deterministic entity interpolation for demo playback.
 *
 * Unlike SnapshotBuffer, this timeline is keyed only by recorded server ticks:
 * it has no receive-time jitter estimation and never extrapolates past the
 * newest recorded state.
 */

import type { EntitySnapshot, InterpolatedEntity } from "../../../engine/network/client/SnapshotBuffer";

interface DemoTimelineSnapshot {
  tick: number;
  entities: Map<string, EntitySnapshot>;
}

const MAX_SNAPSHOTS = 16;
const TELEPORT_SNAP_DIST = 256;

export class DemoEntityTimeline {
  private snapshots: DemoTimelineSnapshot[] = [];
  private lastInsertedTick: number | null = null;

  push(tick: number, entities: Map<string, EntitySnapshot>): void {
    const existing = this.snapshots.findIndex((snapshot) => snapshot.tick === tick);
    const entry = { tick, entities };
    if (existing >= 0) {
      this.snapshots[existing] = entry;
    } else {
      this.snapshots.push(entry);
      this.snapshots.sort((a, b) => a.tick - b.tick);
    }
    this.lastInsertedTick = tick;

    while (this.snapshots.length > MAX_SNAPSHOTS) {
      let farthestIndex = 0;
      let farthestDistance = -1;
      for (let i = 0; i < this.snapshots.length; i++) {
        const distance = Math.abs(this.snapshots[i].tick - tick);
        if (distance > farthestDistance) {
          farthestDistance = distance;
          farthestIndex = i;
        }
      }
      this.snapshots.splice(farthestIndex, 1);
    }
  }

  sample(entityId: string, playheadTick: number): InterpolatedEntity | null {
    const { before, after } = this.findBrackets(playheadTick);

    if (before && after) {
      const beforeEntity = before.entities.get(entityId);
      const afterEntity = after.entities.get(entityId);
      if (beforeEntity && afterEntity) {
        const range = after.tick - before.tick;
        const alpha = range > 0 ? (playheadTick - before.tick) / range : 0;
        return this.interpolate(beforeEntity, afterEntity, alpha);
      }
      if (beforeEntity) return { ...beforeEntity };
      if (afterEntity) return { ...afterEntity };
      return null;
    }

    const snapshot = before ?? after;
    const entity = snapshot?.entities.get(entityId);
    return entity ? { ...entity } : null;
  }

  getEntityIds(playheadTick: number): Set<string> {
    const { before, after } = this.findBrackets(playheadTick);
    const snapshot = before ?? after;
    return snapshot ? new Set(snapshot.entities.keys()) : new Set();
  }

  getSize(): number {
    return this.snapshots.length;
  }

  clear(): void {
    this.snapshots = [];
    this.lastInsertedTick = null;
  }

  /** Keep only the most recently inserted frame as a seek baseline. */
  flush(): void {
    if (this.lastInsertedTick === null) {
      this.clear();
      return;
    }
    const latestInserted = this.snapshots.find((snapshot) => snapshot.tick === this.lastInsertedTick);
    this.snapshots = latestInserted ? [latestInserted] : [];
  }

  private findBrackets(playheadTick: number): {
    before: DemoTimelineSnapshot | null;
    after: DemoTimelineSnapshot | null;
  } {
    let before: DemoTimelineSnapshot | null = null;
    let after: DemoTimelineSnapshot | null = null;
    for (const snapshot of this.snapshots) {
      if (snapshot.tick <= playheadTick) {
        before = snapshot;
      } else {
        after = snapshot;
        break;
      }
    }
    return { before, after };
  }

  private interpolate(a: EntitySnapshot, b: EntitySnapshot, alpha: number): InterpolatedEntity {
    const t = Math.max(0, Math.min(1, alpha));
    const jumpSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2;
    if (jumpSq > TELEPORT_SNAP_DIST * TELEPORT_SNAP_DIST) {
      // A recorded teleport is a discrete change at the newer frame's tick.
      // Hold the old state until that tick instead of revealing the destination early.
      return { ...a };
    }

    let yawDelta = b.yaw - a.yaw;
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;

    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      yaw: a.yaw + yawDelta * t,
      vx: a.vx + (b.vx - a.vx) * t,
      vy: a.vy + (b.vy - a.vy) * t,
      vz: a.vz + (b.vz - a.vz) * t,
      grounded: t < 0.5 ? a.grounded : b.grounded,
      crouching: t < 0.5 ? a.crouching : b.crouching,
      sliding: t < 0.5 ? a.sliding : b.sliding,
      wallJumping: t < 0.5 ? a.wallJumping : b.wallJumping,
      crouchViewOffset:
        (a.crouchViewOffset ?? (a.crouching || a.sliding ? -24 : 0)) +
        ((b.crouchViewOffset ?? (b.crouching || b.sliding ? -24 : 0)) -
          (a.crouchViewOffset ?? (a.crouching || a.sliding ? -24 : 0))) *
          t,
    };
  }
}
