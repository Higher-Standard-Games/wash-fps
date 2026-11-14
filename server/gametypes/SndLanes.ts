/**
 * The ways into each Search & Destroy site, made by `bot:lanes` from the bot
 * nav graph and checked in at `config/bot-lanes/<map>.json`. The gametype
 * sends bot groups along them (`AgentDirective.via`). A map without a file
 * has no lanes, and bots take their own shortest routes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const LANES_DIR = path.join("config", "bot-lanes");

export interface LanePoint {
  x: number;
  y: number;
  z: number;
}

export interface Lane {
  /** Waypoints at standing height, in order, ending at the staging point. */
  via: LanePoint[];
  /** Where a group waits outside the site before going in. */
  staging: LanePoint;
  /** Route length, units. */
  length: number;
}

/** A place to hold a site from, and where to look while there. */
export interface Hold {
  /** Standing height. */
  at: LanePoint;
  /** The way in the other side is likeliest to come by, seen from `at`. */
  watch: LanePoint;
  /** Height above the site's floor, units. */
  rise: number;
}

export interface SiteLanes {
  siteId: number;
  label: string;
  /** From the attackers' spawn or the defenders'. */
  side: "attack" | "defend";
  /** Shortest first. */
  lanes: Lane[];
  /**
   * Where this side holds the site from, best first: for the defence before
   * a plant, for the attack after one. Each sees the site and as many of the
   * other side's ways in as it can, from as high as it can.
   */
  holds?: Hold[];
}

export interface LaneFile {
  version: 1;
  map: string;
  sites: SiteLanes[];
}

const cache = new Map<string, LaneFile | null>();

/** The map's lanes, or null without a file; read once per map and root. */
export function loadLanes(map: string, root = process.cwd()): LaneFile | null {
  const key = `${root}|${map}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let file: LaneFile | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, LANES_DIR, `${map}.json`), "utf8")) as LaneFile;
    if (parsed.version === 1 && Array.isArray(parsed.sites)) file = parsed;
  } catch {
    file = null;
  }
  cache.set(key, file);
  return file;
}

/** The lanes from one side's spawn into one site, shortest first. */
export function lanesInto(file: LaneFile | null, siteId: number, side: "attack" | "defend"): readonly Lane[] {
  return file?.sites.find((s) => s.siteId === siteId && s.side === side)?.lanes ?? [];
}

/** Where one side holds one site from, best first. */
export function holdsAt(file: LaneFile | null, siteId: number, side: "attack" | "defend"): readonly Hold[] {
  return file?.sites.find((s) => s.siteId === siteId && s.side === side)?.holds ?? [];
}
