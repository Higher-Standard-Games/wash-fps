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

/**
 * Client text made safe to keep and re-send: control characters and newlines
 * become spaces, runs of spaces collapse, and the result is trimmed and capped
 * at `maxLength` UTF-16 units.
 *
 * The raw text is cut before the per-character pass, so the work is bounded by
 * the cap rather than by whatever length the client chose to send. Four times
 * the cap leaves room for the spaces the collapse removes.
 */
export function cleanClientText(raw: string, maxLength: number): string {
  let cleaned = "";
  for (const ch of raw.slice(0, maxLength * 4)) {
    const code = ch.charCodeAt(0);
    cleaned += code < 32 || code === 127 ? " " : ch;
  }
  return cleaned.replace(/ {2,}/g, " ").trim().slice(0, maxLength);
}
