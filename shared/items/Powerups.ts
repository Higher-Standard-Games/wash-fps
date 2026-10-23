/**
 * Powerups — timed pickups that modify a player until they expire.
 *
 * Pure rules only (no ECS, no Babylon), so the server, the client HUD, the bots
 * and the tests all agree on duration, multiplier and expiry without importing
 * each other. Expiry is stored as an absolute SERVER TICK rather than a
 * remaining-time countdown: ticks are the authoritative clock, they survive
 * rollback/re-simulation unchanged (see ReSim.ts), and they need no per-tick
 * decrement anywhere.
 *
 * Currently only Quad Damage. `item_warshell` and `item_regen` exist in the map
 * data and in the pk3 icon/sound banks but are deliberately not implemented —
 * adding one is a new entry in POWERUP_KINDS plus its effect hook, not new
 * plumbing.
 */

/** Every implemented powerup, in a STABLE order — the network bitmask indexes this. */
export const POWERUP_KINDS = ["quad"] as const;

export type PowerupKind = (typeof POWERUP_KINDS)[number];

/** Damage/knockback multiplier applied while Quad Damage is held (Q3 classic 4x). */
export const QUAD_MULTIPLIER = 4;

/** How long each powerup lasts once picked up (seconds). */
export const POWERUP_DURATION_SECONDS: Record<PowerupKind, number> = {
  quad: 30,
};

/**
 * How long each powerup takes to come back after being taken (seconds).
 * Every shipped map places exactly ONE item_quad, so this interval is the whole
 * map-control rhythm — long enough that holding quad is worth fighting over.
 */
export const POWERUP_RESPAWN_SECONDS: Record<PowerupKind, number> = {
  quad: 120,
};

/** Human-readable label (HUD toast, frag feed, demo text). */
export const POWERUP_DISPLAY: Record<PowerupKind, string> = {
  quad: "Quad Damage",
};

/** True if `value` names an implemented powerup. */
export function isPowerupKind(value: string): value is PowerupKind {
  return (POWERUP_KINDS as readonly string[]).includes(value);
}

/**
 * Pack held powerups into a byte for the snapshot (bit N = POWERUP_KINDS[N]).
 * Only ACTIVE powerups are packed — an expired entry reads as absent, so a
 * dropped expiry packet can never leave a client glowing forever.
 */
export function packPowerupMask(expiry: PowerupExpiry, tick: number): number {
  let mask = 0;
  for (let i = 0; i < POWERUP_KINDS.length; i++) {
    if (isPowerupActive(expiry, POWERUP_KINDS[i], tick)) mask |= 1 << i;
  }
  return mask;
}

/** True if bit for `kind` is set in a packed mask. */
export function maskHasPowerup(mask: number, kind: PowerupKind): boolean {
  const index = POWERUP_KINDS.indexOf(kind);
  return index >= 0 && (mask & (1 << index)) !== 0;
}

/** Absolute server tick at which each held powerup runs out. Absent = never held. */
export type PowerupExpiry = Partial<Record<PowerupKind, number>>;

/** True while `kind` is held and has not yet expired at `tick`. */
export function isPowerupActive(expiry: PowerupExpiry, kind: PowerupKind, tick: number): boolean {
  const until = expiry[kind];
  return until !== undefined && tick < until;
}

/**
 * Expiry tick for picking `kind` up at `tick`. Re-taking a powerup you already
 * hold EXTENDS it (adds a full duration to the remaining time) rather than
 * resetting it — matching Warsow, and the only sane reading when a single map
 * item is the sole source.
 */
export function grantedExpiryTick(expiry: PowerupExpiry, kind: PowerupKind, tick: number, tickRate: number): number {
  const durationTicks = Math.round(POWERUP_DURATION_SECONDS[kind] * tickRate);
  const base = isPowerupActive(expiry, kind, tick) ? (expiry[kind] as number) : tick;
  return base + durationTicks;
}

/** Seconds left on `kind`, clamped at 0. For the HUD countdown. */
export function powerupSecondsRemaining(
  expiry: PowerupExpiry,
  kind: PowerupKind,
  tick: number,
  tickRate: number,
): number {
  const until = expiry[kind];
  if (until === undefined || tick >= until) return 0;
  return (until - tick) / tickRate;
}

/**
 * Damage/knockback multiplier an attacker applies at `tick`.
 *
 * Quad is Q3-classic here: it scales EVERYTHING the attacker deals, including
 * self-damage and knockback. A quad rocket jump throws you four times as far
 * and usually kills you — that trade is the point.
 */
export function powerupDamageMultiplier(expiry: PowerupExpiry | undefined, tick: number): number {
  if (!expiry) return 1;
  return isPowerupActive(expiry, "quad", tick) ? QUAD_MULTIPLIER : 1;
}
