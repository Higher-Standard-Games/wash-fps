/**
 * A person's call to their team in Search & Destroy: which site to attack.
 * A teammate types "a", "b", "go a", "rush b", "site a" or "b!" in team chat,
 * and the bots on that team go there, as a team of people would follow the
 * call. Anything else is just chat.
 */

/** A team chat line as a call: no "[TEAM] ", lower case, no closing punctuation. */
function callLine(text: string): string {
  return text
    .replace(/^\[TEAM\]\s*/i, "")
    .trim()
    .toLowerCase()
    .replace(/[!.?]+$/, "");
}

/**
 * A person's order to the team, beyond a site:
 * - "go", "now", "rush": attackers go in now; with the bomb armed, defenders retake now.
 * - "wait", "hold": attackers hold at their staging points until "go" (or the deadline).
 * - "retake": defenders retake an armed bomb now.
 * - "stack a", "all on b": every defender to that site this round.
 */
export type TeamCommand = { kind: "go" } | { kind: "wait" } | { kind: "retake" } | { kind: "stack"; site: string };

/** The command a team chat line gives, or null. */
export function teamCommand(text: string): TeamCommand | null {
  const line = callLine(text);
  if (/^(?:go|go go(?: go)?|now|go now|rush|push)$/.test(line)) return { kind: "go" };
  if (/^(?:wait|hold|hold on|wait for me|stop)$/.test(line)) return { kind: "wait" };
  if (/^retake(?: now)?$/.test(line)) return { kind: "retake" };
  const m = /^(?:stack|all on|everyone)\s+([ab])$/.exec(line);
  if (m) return { kind: "stack", site: m[1].toUpperCase() };
  return null;
}

/** The site label a team chat line calls for ("A", "B"), or null. */
export function siteCall(text: string): string | null {
  const line = callLine(text);
  const m = /^(?:(?:go|rush|push|hit|take|site|to|all)\s+)?([ab])(?:\s+(?:site|now|go|rush))?$/.exec(line);
  return m ? m[1].toUpperCase() : null;
}
