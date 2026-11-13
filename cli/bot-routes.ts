/**
 * bot:routes — how the lines bots run along keep off walls, checked offline.
 *
 * For every route from a spawn point to an item on the map, builds the line
 * through each plain walking stretch (RouteLine) and follows it with a simple
 * runner: 400 u/s, turning at most --turn degrees a second toward a point a
 * little way along the line, as a bot's view leads its keys. The same runner
 * follows the raw route, node to node, for comparison. Reports:
 *
 * - how much of each line, and of each run along it, comes within 8 and 24
 *   units of a wall (the gap from the hull);
 * - how much of each run it spends against a wall (sliding along it, as
 *   the game's movement does), and runs that got stuck or left the line;
 * - how many points the lines have against the routes' nodes.
 *
 * No match is played; it takes seconds. Usage:
 *   npm run bot:routes -- --map washoi_dm2 [--turn 300] [--ahead 128]
 */

import { runCli } from "../../../cli/_runCli";
import { PLAYER_HULL, settle } from "../../../shared/collision/WalkFlood";
import type { Vec3 } from "../bot/BotGameState";
import { BotNavCacheStore } from "../bot/BotNavCache";
import { BotNavGraph, type NavPath, wallClearance } from "../bot/BotNavGraph";
import { createBotVision } from "../bot/BotVision";
import { loadLearnedRoutes } from "../bot/LearnedRoutes";
import { buildRouteLine, pointAlong, type RouteWorld, standingOrigin } from "../bot/RouteLine";

const DEG = Math.PI / 180;
const DT = 1 / 125;
const SPEED = 400;
/** The runner gives up after this long on one stretch, seconds. */
const MAX_RUN_SECONDS = 12;
/** The runner has arrived within this of the line's end. */
const ARRIVED = 32;
/** A runner this far from its line has left it. */
const OFF_LINE = 128;
/** Standing origins are this far above the floor. */
const STANDING = 24;
const STEP_UP = 18;
/** The runner drops this far to the floor below, as off a ledge the route walks off. */
const FALL_REACH = 512;

interface Args {
  map: string;
  turn: number;
  ahead: number;
}

function parseArgs(): Args {
  const a: Args = { map: "washoi_dm2", turn: 300, ahead: 128 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--map":
        a.map = next();
        break;
      case "--turn":
        a.turn = Number(next()) || a.turn;
        break;
      case "--ahead":
        a.ahead = Number(next()) || a.ahead;
        break;
      case "--help":
      case "-h":
        console.log("Usage: npm run bot:routes -- [--map washoi_dm2] [--turn 300] [--ahead 128]");
        process.exit(0);
    }
  }
  return a;
}

interface Tally {
  samples: number;
  within8: number;
  within24: number;
}

const tally = (): Tally => ({ samples: 0, within8: 0, within24: 0 });
const count = (t: Tally, gap: number) => {
  t.samples++;
  if (gap < 8) t.within8++;
  if (gap < 24) t.within24++;
};
const pct = (part: number, whole: number) => `${((100 * part) / Math.max(1, whole)).toFixed(0)}%`;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
let timeoutLogs = 0;

async function main(): Promise<void> {
  const args = parseArgs();
  const quiet = console.log;
  console.log = () => {};
  const vision = await createBotVision(args.map);
  let nav = vision ? new BotNavCacheStore().load(args.map, vision.mapKnowledge.mapFingerprint) : null;
  if (vision && !nav) {
    nav = new BotNavGraph(args.map);
    nav.buildFromVision(vision);
  }
  console.log = quiet;
  if (!vision || !nav) throw new Error(`Could not load map "${args.map}"`);
  nav.addLearnedRoutes(loadLearnedRoutes(args.map), (from, to) => vision.isWalkable(from, to));
  const world = vision.collisionWorld;
  const gapAt = (at: Vec3) => wallClearance(world, at, 64, 16).gap;
  const routeWorld: RouteWorld = {
    walkable: (from, to) => vision.isWalkable(from, to),
    clearance: (at, want) => wallClearance(world, at, want, 16),
  };

  /** Clearance along a polyline, sampled every 16 units. */
  const alongLine = (points: readonly Vec3[], t: Tally) => {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const samples = Math.max(1, Math.floor(Math.hypot(b.x - a.x, b.z - a.z) / 16));
      for (let s = 0; s < samples; s++) {
        const u = s / samples;
        count(t, gapAt({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }));
      }
    }
  };

  /** Standing on the floor under `at`, if there is floor within reach. */
  const onFloor = (at: Vec3): Vec3 => {
    const floor = world.trace(
      { x: at.x, y: at.y + STEP_UP + 1, z: at.z },
      { x: at.x, y: at.y - STANDING - FALL_REACH, z: at.z },
    );
    return floor.hit && floor.hitPoint ? { x: at.x, y: floor.hitPoint.y + STANDING, z: at.z } : at;
  };

  /**
   * Run along a polyline as a bot's view leads it, moving as the game's
   * movement does (stepping up stairs, sliding along walls). Counts clearance each tick and the
   * ticks spent against a wall; ends arrived, stuck (no way on), off the line,
   * or out of time.
   */
  const run = (points: readonly Vec3[], t: Tally, contact: { ticks: number }) => {
    let p = onFloor(points[0]);
    const first = pointAlong(points, p, args.ahead).point;
    let heading = Math.atan2(first.x - p.x, first.z - p.z);
    let stretch = 0;
    const end = points[points.length - 1];
    const maxTurn = args.turn * DEG * DT;
    for (let tick = 0; tick < MAX_RUN_SECONDS / DT; tick++) {
      if (Math.hypot(end.x - p.x, end.z - p.z) < ARRIVED) return "arrived";
      const along = pointAlong(points, p, args.ahead, stretch);
      stretch = along.stretch;
      const nearest = pointAlong(points, p, 0, stretch).point;
      if (Math.hypot(nearest.x - p.x, nearest.z - p.z) > OFF_LINE) return "off-line";
      const want = Math.atan2(along.point.x - p.x, along.point.z - p.z);
      heading += Math.max(-maxTurn, Math.min(maxTurn, wrap(want - heading)));
      // The game's own step-and-slide move, then down onto the floor.
      const velocity = { x: Math.sin(heading) * SPEED, y: 0, z: Math.cos(heading) * SPEED };
      const stepped = world.stepSlideMove(p, velocity, DT, PLAYER_HULL).endPos;
      const travelled = Math.hypot(stepped.x - p.x, stepped.z - p.z);
      if (travelled < SPEED * DT * 0.9) contact.ticks++;
      const landed = settle(world, stepped, FALL_REACH);
      const moved = travelled > SPEED * DT * 0.1;
      if (moved) p = landed ?? stepped;
      if (!moved) return "stuck";
      count(t, gapAt(p));
    }
    if (process.env.ROUTES_DEBUG && timeoutLogs++ < 6) {
      const f = (v: Vec3) => `${v.x.toFixed(0)},${v.y.toFixed(0)},${v.z.toFixed(0)}`;
      console.log(`  timeout: line ${points.map(f).join(" > ")}; runner at ${f(p)}`);
    }
    return "timeout";
  };

  if (process.env.ROUTES_DEBUG) {
    let walks = 0;
    let bent = 0;
    for (const edge of nav.edges) {
      if (edge.type !== "walk") continue;
      walks++;
      const way = [
        standingOrigin(nav.nodes[edge.from]),
        ...(edge.via ?? []).map((v) => standingOrigin({ id: -1, type: "floor", position: v })),
        standingOrigin(nav.nodes[edge.to]),
      ];
      if (way.some((p, i) => i > 0 && !vision.isWalkable(way[i - 1], p))) bent++;
    }
    console.log(`  walk edges ${walks}, with a piece not walkable in a straight line ${bent}`);
  }
  const rawLine = tally();
  const smoothLine = tally();
  const rawRun = tally();
  const smoothRun = tally();
  const rawContact = { ticks: 0 };
  const smoothContact = { ticks: 0 };
  const rawEnds = new Map<string, number>();
  const smoothEnds = new Map<string, number>();
  let stretches = 0;
  let rawPoints = 0;
  let smoothPoints = 0;
  let routes = 0;

  const items = vision.mapKnowledge.pickupPositions;
  for (const spawn of vision.mapKnowledge.spawnPoints) {
    const from = (spawn as { position?: Vec3 }).position ?? (spawn as Vec3);
    for (const item of items) {
      const path: NavPath | null = nav.findPath(from, item.position);
      if (!path || path.steps.length === 0) continue;
      routes++;
      // Each plain walking stretch of the route, from where the last one ended.
      let step = 0;
      let start = standingOrigin(path.steps[0].from);
      while (step < path.steps.length) {
        const line = buildRouteLine(start, path, step, routeWorld);
        if (line.endStep > step && line.points.length >= 2) {
          stretches++;
          const raw = [start, ...path.steps.slice(step, line.endStep).map((s) => standingOrigin(s.to))];
          rawPoints += raw.length;
          smoothPoints += line.points.length;
          alongLine(raw, rawLine);
          alongLine(line.points, smoothLine);
          const r = run(raw, rawRun, rawContact);
          const s = run(line.points, smoothRun, smoothContact);
          rawEnds.set(r, (rawEnds.get(r) ?? 0) + 1);
          smoothEnds.set(s, (smoothEnds.get(s) ?? 0) + 1);
        }
        // Past the step the line stopped at: a jump, pad, drop or exact approach.
        const stop = Math.max(line.endStep, step + 1);
        if (stop > path.steps.length) break;
        start = standingOrigin(path.steps[stop - 1].to);
        step = stop;
      }
    }
  }

  const ends = (m: Map<string, number>) =>
    ["arrived", "stuck", "off-line", "timeout"].map((k) => `${k} ${m.get(k) ?? 0}`).join(", ");
  console.log(`\nbot:routes — ${args.map}: ${routes} spawn-to-item routes, ${stretches} walking stretches`);
  console.log(`  runner: ${SPEED} u/s, turning ${args.turn}°/s, steering ${args.ahead} u ahead`);
  console.log("                 within 8 u   within 24 u   points / against a wall, how runs ended");
  console.log(
    `  node to node   ${pct(rawLine.within8, rawLine.samples).padStart(8)}   ${pct(rawLine.within24, rawLine.samples).padStart(11)}   ${rawPoints}`,
  );
  console.log(
    `  smoothed line  ${pct(smoothLine.within8, smoothLine.samples).padStart(8)}   ${pct(smoothLine.within24, smoothLine.samples).padStart(11)}   ${smoothPoints}`,
  );
  console.log(
    `  run, nodes     ${pct(rawRun.within8, rawRun.samples).padStart(8)}   ${pct(rawRun.within24, rawRun.samples).padStart(11)}   ${pct(rawContact.ticks, rawRun.samples)} of ticks; ${ends(rawEnds)}`,
  );
  console.log(
    `  run, smoothed  ${pct(smoothRun.within8, smoothRun.samples).padStart(8)}   ${pct(smoothRun.within24, smoothRun.samples).padStart(11)}   ${pct(smoothContact.ticks, smoothRun.samples)} of ticks; ${ends(smoothEnds)}`,
  );
}

void runCli(main).then(() => process.exit(process.exitCode ?? 0));
