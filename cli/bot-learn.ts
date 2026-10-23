/**
 * Learn bot routes from training demos (`training_demo` in the game console).
 *
 *   npm run bot:learn -- <demo> [<demo> ...] [--dry-run]
 *
 * A demo is a path or a name in public/data/demos/training/. Every trick in it
 * (a flight with a wall jump, a climb higher than a plain jump, a jump over a
 * gap, a teleport flown out of) is
 * re-simulated; the ones that replay reliably from a standstill are saved to
 * config/bot-routes/<map>.json, where the bots' navigation picks them up.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { createBotVision } from "../bot/BotVision";
import { type LearnedRoute, loadLearnedRoutes, saveLearnedRoutes } from "../bot/LearnedRoutes";
import { buildTimeline, findTrickSegments, learnSegment } from "../bot/RouteLearner";
import { resolveFPSDemoMap } from "../client/DemoMapAliases";

const TRAINING_DIR = path.join("public", "data", "demos", "training");

/** Two routes are the same trick when they start and land this close together. */
const SAME_ROUTE = 48;

function resolveDemo(arg: string): string {
  if (fs.existsSync(arg)) return arg;
  const named = path.join(TRAINING_DIR, arg.endsWith(".shagdemo") ? arg : `${arg}.shagdemo`);
  if (fs.existsSync(named)) return named;
  throw new Error(`No demo at ${arg} or ${named}`);
}

const fmt = (p: { x: number; y: number; z: number }) => `${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`;
const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= SAME_ROUTE;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const demos = args.filter((a) => !a.startsWith("--")).map(resolveDemo);
  if (demos.length === 0) {
    console.log("Usage: npm run bot:learn -- <demo> [<demo> ...] [--dry-run]");
    process.exit(1);
  }

  const byMap = new Map<string, LearnedRoute[]>();
  for (const file of demos) {
    const reader = new DemoReader(new Uint8Array(fs.readFileSync(file)));
    const header = reader.readHeader();
    const mapName = resolveFPSDemoMap(header.map);
    const frames = reader.readAllFrames();
    const quiet = console.log;
    console.log = () => {};
    const vision = await createBotVision(mapName);
    console.log = quiet;
    if (!vision) throw new Error(`Cannot load map ${header.map}`);
    const demo = path.basename(file, ".shagdemo");
    const learned = byMap.get(mapName) ?? [];
    byMap.set(mapName, learned);
    for (const player of header.players) {
      const timeline = buildTimeline(frames, player.playerId);
      const segments = findTrickSegments(timeline, vision.collisionWorld);
      console.log(`${demo} (${header.map}), ${player.name}: ${segments.length} tricks`);
      for (const segment of segments) {
        const outcome = learnSegment(timeline, segment, {
          collision: vision.collisionWorld,
          triggers: vision.mapKnowledge.triggerVolumes,
          demo,
        });
        const at = timeline.ticks[segment.takeoff];
        const to = timeline.ticks[segment.landing];
        const what = `tick ${at.tick}: ${fmt(at.position)} -> ${fmt(to.position)}, ${segment.wallJumps} wall jump(s)`;
        if ("rejected" in outcome) {
          console.log(`  - ${what}: rejected, ${outcome.rejected}`);
          continue;
        }
        const r = outcome.route;
        console.log(
          `  + ${what}: run-up from ${fmt(r.start)}, ${r.ticks} ticks, replay error ${r.replayError}, robust ${r.robustness.landed}/${r.robustness.tried}`,
        );
        learned.push(r);
      }
    }
  }

  for (const [map, learned] of byMap) {
    const routes = loadLearnedRoutes(map).filter((old) => !learned.some((r) => r.id === old.id));
    for (const route of learned) {
      const same = routes.findIndex((r) => near(r.start, route.start) && near(r.landing, route.landing));
      if (same < 0) routes.push(route);
      else if (route.replayError < routes[same].replayError) routes[same] = route;
    }
    if (dryRun) {
      console.log(`${map}: ${routes.length} routes (dry run, not saved)`);
    } else {
      const file = saveLearnedRoutes(map, routes);
      console.log(`${map}: ${routes.length} routes saved to ${file}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
