/**
 * BotCallouts — what a bot tells its team, in team chat, as a player would:
 * "2 enemies at Old Town", "Bomb carrier at Warehouse B", "Bomb dropped at
 * Station", "Bomb planted at A". Places are the map's `target_location` names
 * (shared/bsp/LocationTable.ts).
 *
 * Only what the bot itself perceives is called: the enemies it sees, and the
 * objective the match shows every player. The lines are read back by the
 * other bots on the team (`parseCallout`), so information travels between
 * bots the way it travels to a person on the team, and only that way.
 *
 * Pacing: a bot calls at most once per BOT_GAP_MS; the same call (kind and
 * place) is not repeated, by it or after a teammate made it, within
 * REPEAT_MS; and a bot holds a call while a teammate has just spoken.
 */

import { locationName, type MapLocation } from "../../../shared/bsp/LocationTable";
import type { Vec3 } from "./BotGameState";

const BOT_GAP_MS = 3000;
const REPEAT_MS = 8000;
/** A teammate spoke this recently: wait, rather than talk over them. */
const TEAM_QUIET_MS = 1200;
/** Objective news waits up to this long, so one bot says it and the others hear it first. */
const NEWS_DELAY_MS = 2000;

export type CalloutKind = "enemies" | "carrier" | "dropped" | "planted";

export interface Callout {
  kind: CalloutKind;
  /** Enemies seen there (1 for the others). */
  count: number;
  place: string;
}

/** What one decision gives the callouts to work with. */
export interface CalloutView {
  nowMs: number;
  /** Own team; callouts are for team modes only. */
  team: string | null;
  locations: readonly MapLocation[];
  /** Enemies in sight now. */
  enemies: readonly { entityId: string; position: Vec3 }[];
  /** The match objective as every player sees it, when the mode has one. */
  objective?: {
    phase: string;
    position: Vec3 | null;
    carrier: string | null;
    site: string | null;
  };
}

/** The line for a call, as sent: team chat. */
export function calloutText(call: Callout): string {
  switch (call.kind) {
    case "enemies":
      return `/say_team ${call.count > 1 ? `${call.count} enemies` : "Enemy"} at ${call.place}`;
    case "carrier":
      return `/say_team Bomb carrier at ${call.place}`;
    case "dropped":
      return `/say_team Bomb dropped at ${call.place}`;
    case "planted":
      return `/say_team Bomb planted at ${call.place}`;
  }
}

/** A call read from a team chat line (with or without the "[TEAM] " the server adds), or null. */
export function parseCallout(text: string): Callout | null {
  const line = text.replace(/^\[TEAM\]\s*/, "").trim();
  let m = /^(\d+) enemies at (.+)$/.exec(line);
  if (m) return { kind: "enemies", count: Number(m[1]), place: m[2] };
  m = /^Enemy at (.+)$/.exec(line);
  if (m) return { kind: "enemies", count: 1, place: m[1] };
  m = /^Bomb (carrier|dropped|planted) at (.+)$/.exec(line);
  if (m) return { kind: m[1] as CalloutKind, count: 1, place: m[2] };
  return null;
}

/** Where a place is: the middle of the locations with that name, or null. */
export function placePosition(locations: readonly MapLocation[], place: string): Vec3 | null {
  const named = locations.filter((l) => l.name === place);
  if (named.length === 0) return null;
  const sum = named.reduce((s, l) => ({ x: s.x + l.position.x, y: s.y + l.position.y, z: s.z + l.position.z }), {
    x: 0,
    y: 0,
    z: 0,
  });
  return { x: sum.x / named.length, y: sum.y / named.length, z: sum.z / named.length };
}

export class BotCallouts {
  private lastSaidMs = Number.NEGATIVE_INFINITY;
  private lastTeamMs = Number.NEGATIVE_INFINITY;
  /** When each call (kind|place) was last made by anyone on the team. */
  private readonly made = new Map<string, number>();
  /** The objective phase last seen, to call a change once. */
  private lastPhase: string | null = null;
  /** Objective news not yet said: a drop or a plant, kept until the bot may speak. */
  private news: { call: Callout; atMs: number; dueMs: number } | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** A teammate's team chat line. */
  heard(text: string, nowMs: number): Callout | null {
    this.lastTeamMs = nowMs;
    const call = parseCallout(text);
    if (call) {
      this.made.set(`${call.kind}|${call.place}`, nowMs);
      if (this.news && this.news.call.kind === call.kind && this.news.call.place === call.place) this.news = null;
    }
    return call;
  }

  /** The call to make now, as team chat text, or null. */
  observe(view: CalloutView): string | null {
    this.noteObjective(view);
    if (!view.team || view.locations.length === 0) return null;
    if (view.nowMs - this.lastSaidMs < BOT_GAP_MS || view.nowMs - this.lastTeamMs < TEAM_QUIET_MS) return null;
    if (this.news && view.nowMs - this.news.atMs >= REPEAT_MS) this.news = null;
    const due = this.news && view.nowMs >= this.news.dueMs ? this.news.call : null;
    if (due) this.news = null;
    // News not yet due holds back sightings too: it goes first.
    const fresh = due ?? (this.news ? null : undefined);
    if (fresh === null) return null;
    const call = fresh ?? this.sighting(view);
    if (!call) return null;
    const key = `${call.kind}|${call.place}`;
    if (view.nowMs - (this.made.get(key) ?? Number.NEGATIVE_INFINITY) < REPEAT_MS) return null;
    this.made.set(key, view.nowMs);
    this.lastSaidMs = view.nowMs;
    return calloutText(call);
  }

  /** A drop or a plant becomes news the moment the objective changes. */
  private noteObjective(view: CalloutView): void {
    const objective = view.objective;
    const phase = objective?.phase ?? null;
    const before = this.lastPhase;
    this.lastPhase = phase;
    if (!objective?.position || phase === before || before !== "carried") return;
    const place = locationName(view.locations, objective.position);
    const due = view.nowMs + this.random() * NEWS_DELAY_MS;
    if (phase === "dropped" && place) this.news = { call: { kind: "dropped", count: 1, place }, atMs: view.nowMs, dueMs: due };
    if (phase === "planted" || phase === "armed") {
      const where = objective.site ?? place;
      if (where) this.news = { call: { kind: "planted", count: 1, place: where }, atMs: view.nowMs, dueMs: due };
    }
  }

  /** The enemy carrier in sight, else the place with the most enemies in sight. */
  private sighting(view: CalloutView): Callout | null {
    const at = (p: Vec3) => locationName(view.locations, p);
    const carrierId = view.objective?.carrier;
    const carrier = carrierId ? view.enemies.find((e) => e.entityId === carrierId) : undefined;
    if (carrier) {
      const place = at(carrier.position);
      if (place) return { kind: "carrier", count: 1, place };
    }
    const counts = new Map<string, number>();
    for (const enemy of view.enemies) {
      const place = at(enemy.position);
      if (place) counts.set(place, (counts.get(place) ?? 0) + 1);
    }
    const busiest = [...counts].sort((a, b) => b[1] - a[1])[0];
    return busiest ? { kind: "enemies", count: busiest[1], place: busiest[0] } : null;
  }
}
