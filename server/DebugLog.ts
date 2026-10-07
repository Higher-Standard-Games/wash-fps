/**
 * Opt-in diagnostics for the server console.
 *
 * Set `SHAG_DEBUG` to a comma-separated list of topics (or `all`) to print them:
 *
 *   SHAG_DEBUG=phys,kb npm run server
 *
 * Topics:
 *   phys         one line per player per second from the movement subsystem
 *   kb           knockback applied and the position after the tick it was applied
 *   falldamage   every landing, with the drop and which damage band it fell in
 *   input        one sample of the input buttons every 200 commands
 *   perf         snapshot encode cost every 100 ticks
 *   discharge    a shot fired into water
 *
 * Everything else the server prints is a lifecycle event (a player joins, a match starts, a demo
 * is saved) or a problem. Nothing prints per tick, per snapshot or per hit unless asked for.
 * The environment is read once, when this module loads.
 */

export type DebugTopic = "phys" | "kb" | "falldamage" | "input" | "perf" | "discharge";

function parseTopics(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((topic) => topic.trim())
      .filter(Boolean),
  );
}

const topics = parseTopics(typeof process !== "undefined" ? process.env?.SHAG_DEBUG : undefined);

/** Whether a topic was asked for. Check this before building an expensive message. */
export function debugEnabled(topic: DebugTopic): boolean {
  return topics.has("all") || topics.has(topic);
}

/** Print a line for a topic, only if it was asked for. */
export function debugLog(topic: DebugTopic, message: () => string): void {
  if (debugEnabled(topic)) console.log(message());
}

export { parseTopics as parseDebugTopics };
