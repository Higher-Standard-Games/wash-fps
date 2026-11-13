/**
 * bot:lanes — the ways into each Search & Destroy site, for the gametype to
 * send bot groups by (server/gametypes/SndLanes.ts).
 *
 * For each side's spawn (attackers use the beta set, defenders the alpha set)
 * and each site, up to LANES_PER_SITE routes over the bot nav graph that share
 * as little as they can: after each, the middle of its route is blocked and
 * the next is searched. A route much longer than the first, or mostly the
 * same ground, is dropped. Each lane is its waypoints, one about every
 * WAYPOINT_SPACING units, ending at a staging point about STAGING_DISTANCE
 * short of the site, where a group can wait for the others.
 *
 * Writes `config/bot-lanes/<map>.json`; review it, then commit it.
 *
 * Usage:
 *   npm run bot:lanes -- --map washoi_snd1 [--dry-run]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runCli } from "../../../cli/_runCli";
import { extractBombSites, isInsideBombSite, spawnCentroid } from "../../../shared/bsp/BombSiteTable";
import type { Vec3 } from "../bot/BotGameState";
import { BotNavCacheStore } from "../bot/BotNavCache";
import { BotNavGraph, type NavPath, navEdgeKey } from "../bot/BotNavGraph";
import { createBotVision } from "../bot/BotVision";
import { loadLearnedRoutes } from "../bot/LearnedRoutes";
import { LANES_DIR, type LaneFile, type SiteLanes } from "../server/gametypes/SndLanes";
import { loadBspCollision } from "./HeadlessMapLoader";

const LANES_PER_SITE = 3;
/** A lane longer than this times the shortest is no lane anyone takes. */
const MAX_DETOUR = 1.8;
/** Lanes whose staging points are closer than this go in by the same way. */
const MIN_STAGING_APART = 350;
/** A detour avoids every node this close to the probed one, units. */
const BLOCK_RADIUS = 300;
/** Path searches per site and side. */
const MAX_SEARCHES = 48;
/** How far back from the site a lane's approach counts, units. */
const APPROACH = 1800;
/** Approach nodes a detour is tried round. */
const DETOUR_PROBES = 16;
/** Nodes at each end not counted as the middle: lanes may share the spawn and the site. */
const SHARED_ENDS = 2;
const WAYPOINT_SPACING = 250;
const STAGING_DISTANCE = 300;
/** Player origin above the feet. */
const ORIGIN_HEIGHT = 24;

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

function pathLength(nodes: readonly { position: Vec3 }[]): number {
  let length = 0;
  for (let i = 1; i < nodes.length; i++) length += horizontal(nodes[i - 1].position, nodes[i].position);
  return length;
}

/** Waypoints at standing height about every WAYPOINT_SPACING, up to the staging point. */
function laneOf(route: NavPath): { via: Vec3[]; staging: Vec3; length: number } {
  const nodes = route.nodes;
  const total = pathLength(nodes);
  const via: Vec3[] = [];
  let travelled = 0;
  let sinceLast = 0;
  let staging = nodes[0].position;
  for (let i = 1; i < nodes.length; i++) {
    const step = horizontal(nodes[i - 1].position, nodes[i].position);
    travelled += step;
    sinceLast += step;
    if (total - travelled < STAGING_DISTANCE) break;
    const p = nodes[i].position;
    staging = { x: p.x, y: p.y + ORIGIN_HEIGHT, z: p.z };
    if (sinceLast >= WAYPOINT_SPACING) {
      via.push(staging);
      sinceLast = 0;
    }
  }
  const last = via[via.length - 1];
  if (!last || horizontal(last, staging) > 1) via.push(staging);
  return { via: via.map(round), staging: round(staging), length: Math.round(total) };
}

const round = (p: Vec3): Vec3 => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });

/**
 * Candidate routes: the shortest, then detours round regions of its approach
 * (every node within BLOCK_RADIUS of one of its nodes blocked), and round the approaches of the
 * detours found, up to MAX_SEARCHES searches. Kept greedily by where they end:
 * each new lane's staging point is the farthest from the kept ones, and at
 * least MIN_STAGING_APART from each. Routes that differ only before the last
 * stretch go in by the same door and are one lane.
 */
function lanesBetween(
  nav: BotNavGraph,
  from: Vec3,
  to: Vec3,
  canWalkTo: (a: Vec3, b: Vec3) => boolean,
): SiteLanes["lanes"] {
  const first = nav.findPath(from, to, { canWalkTo });
  if (!first || first.nodes.length < 2) return [];
  // The approach: nodes within APPROACH of the site along the route, short
  // of the last SHARED_ENDS (the site itself).
  const approachOf = (route: NavPath) => {
    const nodes = route.nodes;
    const ids: number[] = [];
    let remaining = 0;
    for (let i = nodes.length - 1; i > 0; i--) {
      remaining += horizontal(nodes[i].position, nodes[i - 1].position);
      if (remaining > APPROACH) break;
      if (i - 1 < nodes.length - SHARED_ENDS) ids.push(nodes[i - 1].id);
    }
    return ids;
  };
  const shortest = pathLength(first.nodes);
  const candidates = [laneOf(first)];
  const queue: NavPath[] = [first];
  const probed = new Set<number>();
  let searches = 0;
  while (queue.length > 0 && searches < MAX_SEARCHES) {
    const route = queue.shift() as NavPath;
    const probes = approachOf(route).filter((id) => !probed.has(id));
    const step = Math.max(1, Math.floor(probes.length / DETOUR_PROBES));
    for (let i = 0; i < probes.length && searches < MAX_SEARCHES; i += step) {
      probed.add(probes[i]);
      // Block a region, not a node: round a single node the floor grid gives
      // a neighbour, and the detour came back to the same door.
      const centre = nav.nodes[probes[i]].position;
      const region = new Set(nav.nodes.filter((n) => horizontal(n.position, centre) <= BLOCK_RADIUS).map((n) => n.id));
      const blocked = new Set<string>();
      for (const edge of nav.edges) {
        if (region.has(edge.from) || region.has(edge.to)) blocked.add(navEdgeKey(edge.from, edge.to, edge.type));
      }
      searches++;
      const detour = nav.findPath(from, to, { blockedEdgeKeys: blocked, canWalkTo });
      if (!detour || pathLength(detour.nodes) > shortest * MAX_DETOUR) continue;
      const lane = laneOf(detour);
      if (candidates.every((c) => horizontal(c.staging, lane.staging) >= MIN_STAGING_APART)) queue.push(detour);
      candidates.push(lane);
    }
  }
  const kept = [candidates[0]];
  while (kept.length < LANES_PER_SITE) {
    let best: (typeof candidates)[number] | null = null;
    let bestApart = MIN_STAGING_APART;
    for (const c of candidates) {
      if (kept.includes(c)) continue;
      const apart = Math.min(...kept.map((k) => horizontal(c.staging, k.staging)));
      if (apart >= bestApart) {
        best = c;
        bestApart = apart;
      }
    }
    if (!best) break;
    kept.push(best);
  }
  return kept;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const mapAt = argv.indexOf("--map");
  const map = mapAt >= 0 ? argv[mapAt + 1] : undefined;
  if (!map || argv.includes("--help")) {
    console.log("Usage: npm run bot:lanes -- --map <washoi_snd1> [--dry-run]");
    return;
  }
  const quiet = console.log;
  console.log = () => {};
  const bsp = await loadBspCollision(map, "./game");
  const vision = await createBotVision(map);
  let nav = vision ? new BotNavCacheStore().load(map, vision.mapKnowledge.mapFingerprint) : null;
  if (vision && !nav) {
    nav = new BotNavGraph(map);
    nav.buildFromVision(vision);
  }
  console.log = quiet;
  if (!bsp || !vision || !nav) throw new Error(`Could not load map "${map}"`);
  const walk = (a: Vec3, b: Vec3) => vision.isWalkable(a, b);
  nav.addLearnedRoutes(loadLearnedRoutes(map), walk);

  const floorOf = (p: Vec3): Vec3 => {
    const hit = bsp.collision.trace({ ...p }, { x: p.x, y: p.y - 512, z: p.z });
    return hit.fraction >= 1 ? { ...p } : { x: p.x, y: p.y - 512 * hit.fraction, z: p.z };
  };
  const sites = extractBombSites(bsp.entities, bsp.models);
  const spawnOf = (team: string): Vec3 | null => {
    const centre = spawnCentroid(bsp.teamSpawnPoints.get(team) ?? []);
    if (!centre) return null;
    const floor = floorOf(centre);
    return { x: floor.x, y: floor.y + ORIGIN_HEIGHT, z: floor.z };
  };
  const sides = { attack: spawnOf("soba"), defend: spawnOf("udon") };
  const file: LaneFile = { version: 1, map, sites: [] };
  for (const site of sites) {
    const floor = floorOf(site.position);
    const standing = { x: floor.x, y: floor.y + ORIGIN_HEIGHT, z: floor.z };
    const target = isInsideBombSite(site, standing) ? standing : site.position;
    for (const [side, from] of Object.entries(sides) as ["attack" | "defend", Vec3 | null][]) {
      if (!from) continue;
      const lanes = lanesBetween(nav, from, target, walk);
      file.sites.push({ siteId: site.id, label: site.label, side, lanes });
      console.log(
        `${map} site ${site.label} ${side}: ${lanes.length} lanes, ${lanes.map((l) => `${l.length}u/${l.via.length} waypoints`).join(", ")}`,
      );
    }
  }
  if (argv.includes("--dry-run")) return;
  const out = path.join(process.cwd(), LANES_DIR, `${map}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`  → ${out}`);
}

void runCli(main).then(() => process.exit(process.exitCode ?? 0));
