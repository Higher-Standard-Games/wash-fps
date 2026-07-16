/**
 * ClientEntityKey — the single place that mints and parses the client-facing
 * entity-key string format.
 *
 * The server addresses entities by numeric id; the client (and the wire
 * snapshot) key them by a `player_<id>` string. This convention used to be
 * minted and parsed ad hoc across ~20 sites — and a format mismatch silently
 * broke the post-game showcase (QA-5). Route every mint/parse through here so
 * the format is defined exactly once.
 */

/** Prefix that namespaces a server entity id into a client entity key. */
export const CLIENT_KEY_PREFIX = "player_";

/** Server entity id → client entity key string (`player_<id>`). */
export function toClientKey(entityId: number | string): string {
  return `${CLIENT_KEY_PREFIX}${entityId}`;
}

/** True if `key` is a client entity key (has the prefix). */
export function isClientKey(key: string): boolean {
  return key.startsWith(CLIENT_KEY_PREFIX);
}

/**
 * Client entity key → numeric id, or null if it isn't a well-formed key.
 * Guarantee: `parseClientKey(toClientKey(n)) === n` for any finite number `n`.
 */
export function parseClientKey(key: string): number | null {
  if (!isClientKey(key)) return null;
  const rest = key.slice(CLIENT_KEY_PREFIX.length);
  if (rest === "") return null;
  const n = Number(rest);
  return Number.isFinite(n) ? n : null;
}

/** Strip the prefix for display (`player_3` → `3`); returns non-keys unchanged. */
export function clientKeyDisplayId(key: string): string {
  return isClientKey(key) ? key.slice(CLIENT_KEY_PREFIX.length) : key;
}

/** Normalize a possibly-bare id to a client key (idempotent). */
export function ensureClientKey(idOrKey: string): string {
  return isClientKey(idOrKey) ? idOrKey : toClientKey(idOrKey);
}
