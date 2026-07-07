/**
 * Small pure guards for client-controlled connection metadata.
 *
 * Kept separate from GameServer so rate/ack edge behavior can be unit-tested
 * without constructing a transport.
 */

export function rateLimited(lastAcceptedMs: number | undefined, nowMs: number, windowMs: number): boolean {
  if (lastAcceptedMs === undefined) return false;
  return nowMs - lastAcceptedMs < windowMs;
}

export function nextAckedTick(lastAckedTick: number, ackedTick: number, serverTick: number): number {
  if (ackedTick > lastAckedTick && ackedTick <= serverTick) {
    return ackedTick;
  }
  return lastAckedTick;
}
