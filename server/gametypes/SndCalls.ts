/**
 * A person's call to their team in Search & Destroy: which site to attack.
 * A teammate types "a", "b", "go a", "rush b", "site a" or "b!" in team chat,
 * and the bots on that team go there, as a team of people would follow the
 * call. Anything else is just chat.
 */

/** The site label a team chat line calls for ("A", "B"), or null. */
export function siteCall(text: string): string | null {
  const line = text
    .replace(/^\[TEAM\]\s*/i, "")
    .trim()
    .toLowerCase()
    .replace(/[!.?]+$/, "");
  const m = /^(?:(?:go|rush|push|hit|take|site|to|all)\s+)?([ab])(?:\s+(?:site|now|go|rush))?$/.exec(line);
  return m ? m[1].toUpperCase() : null;
}
