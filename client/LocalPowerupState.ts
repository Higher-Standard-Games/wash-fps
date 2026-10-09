/**
 * LocalPowerupState — the local player's own powerup timers, for the HUD and
 * for client-side feedback (the quad fire layer).
 *
 * The server emits `powerup_state` every snapshot ONLY while a timer is running,
 * so this module never needs an explicit "expired" message: each update stores a
 * wall-clock deadline and the powerup simply reads as inactive once that passes.
 * A dropped final packet therefore ends the effect on time instead of leaving it
 * stuck on — the same fail-closed reasoning as the pickup active-set mask.
 *
 * A snapshot that arrives without a powerup's `powerup_state` ends it at once
 * (`keepOnlyLocalPowerups`): the server took it away before its time, as a round
 * start does to a player who is respawned without dying.
 *
 * Cosmetic only. Damage is applied server-side (CombatSystem); nothing here can
 * change what a shot does.
 */

/** Clock deadline (performance.now() ms) per powerup kind. */
const deadlines = new Map<string, number>();

/**
 * Record an authoritative countdown for the local player.
 * `seconds` is whole seconds remaining, as sent by the server.
 */
export function setLocalPowerup(kind: string, seconds: number): void {
  if (!kind) return;
  if (seconds <= 0) {
    deadlines.delete(kind);
    return;
  }
  deadlines.set(kind, performance.now() + seconds * 1000);
}

/** True while the local player holds `kind`. */
export function isLocalPowerupActive(kind: string): boolean {
  const deadline = deadlines.get(kind);
  if (deadline === undefined) return false;
  if (performance.now() >= deadline) {
    deadlines.delete(kind);
    return false;
  }
  return true;
}

/** Seconds left on `kind` (0 when not held). For the HUD countdown. */
export function localPowerupSeconds(kind: string): number {
  const deadline = deadlines.get(kind);
  if (deadline === undefined) return 0;
  return Math.max(0, (deadline - performance.now()) / 1000);
}

/** Every powerup the local player currently holds, with seconds left. */
export function activeLocalPowerups(): Array<{ kind: string; seconds: number }> {
  const now = performance.now();
  const out: Array<{ kind: string; seconds: number }> = [];
  for (const [kind, deadline] of deadlines) {
    if (now >= deadline) {
      deadlines.delete(kind);
      continue;
    }
    out.push({ kind, seconds: (deadline - now) / 1000 });
  }
  return out;
}

/**
 * Keep only the powerups a snapshot said are running. The server sends
 * `powerup_state` in every snapshot while one runs, so one missing from a
 * snapshot that arrived has ended, whatever its deadline said.
 */
export function keepOnlyLocalPowerups(running: ReadonlySet<string>): void {
  for (const kind of deadlines.keys()) if (!running.has(kind)) deadlines.delete(kind);
}

/** Drop all timers — on death, map change, or disconnect. */
export function clearLocalPowerups(): void {
  deadlines.clear();
}
