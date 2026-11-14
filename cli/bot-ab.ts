/**
 * bot:ab — two bot variants head to head over many headless matches.
 *
 * A single two-bot Duel says little: two runs of the same code can differ
 * threefold in deaths. This plays many matches with one bot of arm A against
 * one of arm B (or `--per-arm` of each in Deathmatch), alternating who joins
 * first, and reports wins, the frag gap per match and a 95% interval on it,
 * so a change can be told from noise.
 *
 * Arms are `BotOptions` as JSON, the same options a bot is added with:
 *
 *   npm run bot:ab -- --a '{"difficulty":"hard"}' --b '{"difficulty":"medium"}'
 *   npm run bot:ab -- --map washoi_dm5 --matches 24 --parallel 4 --seconds 120 --a '{}' --b '{"goalArbiter":"legacy"}'
 *
 * In Search & Destroy (`--gametype snd`) each arm is a whole team of
 * `--per-arm` bots, the arms change sides from match to match, and a match
 * is scored by rounds won, as attacker and as defender, with plants and how
 * the rounds ended; kills per death is reported so a tactic that wins rounds
 * by fighting worse shows.
 *
 * Matches run in `--parallel` worker processes (this file with `--worker`), each
 * on its own ports, so one slow match does not stall the rest.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MatchPhase } from "@shared/server/gametype";
import { runCli } from "../../../cli/_runCli";
import { signTest } from "../bot/AbStats";
import type { BotOptions } from "../bot/BotConfig";
import { BotServer } from "../bot/BotServer";
import { isMajorItem } from "../bot/goals/considerations/ItemFacts";
import { GameServer } from "../server/GameServer";
import type { BaseGametype } from "../server/gametypes/BaseGametype";
import { Deathmatch } from "../server/gametypes/Deathmatch";
import { Duel } from "../server/gametypes/Duel";
import { type CoachPart, SearchAndDestroy } from "../server/gametypes/SearchAndDestroy";
import { loadBspCollision } from "./HeadlessMapLoader";

interface Args {
  map: string;
  gametype: string;
  matches: number;
  seconds: number;
  parallel: number;
  perArm: number;
  port: number;
  /** Bot options, and `routesRoot`: a folder whose config/bot-routes this arm's routes come from. */
  a: ArmOptions;
  b: ArmOptions;
  worker: boolean;
  /** Worker: index of the first match it plays, for alternating join order. */
  first: number;
}

/** One match's result, as a worker prints it. */
type ArmOptions = Partial<BotOptions> & {
  routesRoot?: string;
  /**
   * Search & Destroy: false plays this arm's team without the gametype's
   * coach; a list plays only those parts of it (COACH_PARTS).
   */
  coach?: boolean | CoachPart[];
};

export interface MatchResult {
  match: number;
  frags: { a: number; b: number };
  deaths: { a: number; b: number };
  /** Major items each arm took, by label (Red Armor, Mega Health, ...), as the server granted them. */
  majors?: { a: Record<string, number>; b: Record<string, number> };
  /** Seconds each arm's bots spent in each strategy, sampled once a second. */
  strategies?: { a: Record<string, number>; b: Record<string, number> };
  /** Search & Destroy: each round's winning arm (or null), the winner's role, how it ended, and whether a bomb was placed. */
  rounds?: { winner: "a" | "b" | null; role: string; reason: string; planted: boolean }[];
}

/** The two Search & Destroy teams. */
const SND_TEAMS = ["udon", "soba"] as const;

const isTeamMode = (args: Args) => args.gametype.toLowerCase() === "snd";

function parseArgs(): Args {
  const a: Args = {
    map: "washoi_dm5",
    gametype: "duel",
    matches: 12,
    seconds: 120,
    parallel: 3,
    perArm: 1,
    port: 8100,
    a: {},
    b: {},
    worker: false,
    first: 0,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--map":
        a.map = next();
        break;
      case "--gametype":
        a.gametype = next();
        break;
      case "--matches":
        a.matches = Math.max(1, Number(next()) || a.matches);
        break;
      case "--seconds":
        a.seconds = Math.max(20, Number(next()) || a.seconds);
        break;
      case "--parallel":
        a.parallel = Math.max(1, Number(next()) || a.parallel);
        break;
      case "--per-arm":
        a.perArm = Math.max(1, Number(next()) || a.perArm);
        break;
      case "--port":
        a.port = Number(next()) || a.port;
        break;
      case "--a":
        a.a = JSON.parse(next());
        break;
      case "--b":
        a.b = JSON.parse(next());
        break;
      case "--worker":
        a.worker = true;
        break;
      case "--first":
        a.first = Number(next()) || 0;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: npm run bot:ab -- [--map washoi_dm5] [--gametype duel|ffa|snd] [--matches 12] [--seconds 120] [--parallel 3] [--per-arm 1] [--port 8100] --a '<BotOptions JSON>' --b '<BotOptions JSON>'",
        );
        process.exit(0);
    }
  }
  return a;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeGametype(name: string): BaseGametype {
  const key = name.toLowerCase();
  if (key === "duel") return new Duel();
  if (key === "snd") return new SearchAndDestroy();
  return new Deathmatch();
}

/** Play one match on `port`; arm A joins first when `aFirst`. */
async function playMatch(args: Args, port: number, aFirst: boolean, match: number): Promise<MatchResult> {
  const bsp = await loadBspCollision(args.map, "./game");
  if (!bsp) throw new Error(`Could not load map "${args.map}"`);
  const gametype = makeGametype(args.gametype);
  const server = new GameServer(
    {
      port,
      serverName: "bot-ab",
      mapName: args.map,
      maxClients: 16,
      tickRate: 125,
      snapshotRate: 60,
      certPath: "",
      keyPath: "",
    },
    gametype,
  );
  server.setCollisionWorld(bsp.collision);
  server.setSpawnPoints(bsp.spawnPoints, bsp.teamSpawnPoints);
  server.setMapData(bsp.entities, bsp.models);
  server.setPickupItems(bsp.pickups);
  server.setTriggerVolumes(bsp.triggers);
  server.setPickupRespawnTime(15);
  if (bsp.pvs) server.setPVSData(bsp.pvs);
  await server.start();
  // Count the major items each bot is granted, from the server's own pickup notices.
  const granted = new Map<number, Record<string, number>>();
  const pickups = (
    server as unknown as { pickupSystem: { notifyPickup(id: number, type: string, kind: string): void } }
  ).pickupSystem;
  const notify = pickups.notifyPickup.bind(pickups);
  pickups.notifyPickup = (id, type, kind) => {
    notify(id, type, kind);
    if (!isMajorItem(type, kind)) return;
    const counts = granted.get(Number(id)) ?? {};
    counts[kind] = (counts[kind] ?? 0) + 1;
    granted.set(Number(id), counts);
  };
  // One bot server per arm, so an arm can read its own route libraries
  // ("routesRoot" in its options: a folder holding config/bot-routes).
  const servers = {
    a: new BotServer(port + 50, { routesRoot: args.a.routesRoot }),
    b: new BotServer(port + 51, { routesRoot: args.b.routesRoot }),
  };
  // Search & Destroy: arm A plays the first team when `aFirst`; rounds are
  // recorded as the controller ends them.
  const teamOf = { a: SND_TEAMS[aFirst ? 0 : 1], b: SND_TEAMS[aFirst ? 1 : 0] } as const;
  const armOf = (team: string | null) => (team === teamOf.a ? "a" : team === teamOf.b ? "b" : null);
  const rounds: NonNullable<MatchResult["rounds"]> = [];
  let planted = false;
  const controller = server.getGametypeController();
  if (gametype instanceof SearchAndDestroy) {
    for (const arm of ["a", "b"] as const) {
      const coach = args[arm].coach;
      if (coach !== undefined && coach !== true) gametype.setTeamCoach(teamOf[arm], coach);
    }
  }
  if (isTeamMode(args)) {
    const endRound = controller.endRound.bind(controller);
    controller.endRound = (winner, outcome) => {
      const roles = controller.getMatchSnapshot().teamRoles ?? {};
      rounds.push({
        winner: armOf(winner),
        role: winner ? (roles[winner] ?? "?") : "none",
        reason: outcome?.resultKey ?? "eliminated",
        planted,
      });
      planted = false;
      endRound(winner, outcome);
    };
  }
  try {
    const order: ("a" | "b")[] = [];
    for (let i = 0; i < args.perArm; i++) order.push(...((aFirst ? ["a", "b"] : ["b", "a"]) as ("a" | "b")[]));
    const bots = [];
    for (const arm of order) {
      if (bots.length > 0) await wait(400);
      const { routesRoot: _root, coach: _coach, ...armOptions } = { chat: false, ...(arm === "a" ? args.a : args.b) };
      const options = isTeamMode(args) ? { ...armOptions, team: teamOf[arm] } : armOptions;
      bots.push({ arm, bot: await servers[arm].addBot(`ws://localhost:${port}`, options) });
    }
    await wait(2000);
    const state = server.getGametypeController().getMatchState();
    state.expireWarmup();
    for (let i = 0; i < 100 && state.phase !== MatchPhase.Active; i++) await wait(100);
    const strategies: MatchResult["strategies"] = { a: {}, b: {} };
    for (let s = 0; s < args.seconds; s++) {
      await wait(1000);
      const phase = controller.getMatchSnapshot().objective as { phase?: string } | undefined;
      if (phase?.phase === "planted" || phase?.phase === "armed") planted = true;
      for (const { arm, bot } of bots) {
        const id = bot.strategyId ?? "none";
        strategies[arm][id] = (strategies[arm][id] ?? 0) + 1;
      }
    }

    // Every bot sees the scoreboard; read it from the first, by each bot's own player id.
    const board = (bots[0].bot as unknown as { _gameState: { scores: Map<string, { score: number; deaths: number }> } })
      ._gameState.scores;
    const majors: MatchResult["majors"] = { a: {}, b: {} };
    for (const { arm, bot } of bots) {
      const id = Number(String(bot.entityId).replace(/^player_/, ""));
      for (const [kind, n] of Object.entries(granted.get(id) ?? {})) majors[arm][kind] = (majors[arm][kind] ?? 0) + n;
    }
    const result: MatchResult = { match, frags: { a: 0, b: 0 }, deaths: { a: 0, b: 0 }, strategies, majors };
    if (isTeamMode(args)) result.rounds = rounds;
    for (const { arm, bot } of bots) {
      const id = (bot as unknown as { _gameState: { selfPlayerId: string } })._gameState.selfPlayerId;
      const row = board.get(id);
      result.frags[arm] += row?.score ?? 0;
      result.deaths[arm] += row?.deaths ?? 0;
    }
    return result;
  } finally {
    await servers.a.removeAllBots().catch(() => 0);
    await servers.b.removeAllBots().catch(() => 0);
    await server.stop();
  }
}

async function worker(args: Args): Promise<void> {
  const demoDir = await mkdtemp(join(tmpdir(), "bot-ab-"));
  process.env.SHAG_DEMO_DIR = demoDir;
  const print = console.log;
  console.log = () => {};
  try {
    for (let m = 0; m < args.matches; m++) {
      const match = args.first + m;
      const result = await playMatch(args, args.port + m * 2, match % 2 === 0, match);
      print(`RESULT ${JSON.stringify(result)}`);
    }
  } finally {
    console.log = print;
    await rm(demoDir, { recursive: true, force: true });
  }
}

/** Rounds an arm won in a match. */
const roundsWon = (r: MatchResult, arm: "a" | "b") => (r.rounds ?? []).filter((x) => x.winner === arm).length;

/** Search & Destroy: rounds by side, plants, how rounds ended, kills per death. */
function summarizeRounds(args: Args, results: MatchResult[]): void {
  const n = results.length;
  const gaps = results.map((r) => roundsWon(r, "a") - roundsWon(r, "b"));
  const mean = gaps.reduce((s, g) => s + g, 0) / Math.max(1, n);
  const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / Math.max(1, n - 1));
  const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : Number.NaN;
  const winsA = gaps.filter((g) => g > 0).length;
  const winsB = gaps.filter((g) => g < 0).length;
  const all = results.flatMap((r) => r.rounds ?? []);
  const won = (arm: "a" | "b", role: string) => all.filter((x) => x.winner === arm && x.role === role).length;
  const total = (pick: (r: MatchResult) => number) => results.reduce((sum, r) => sum + pick(r), 0);
  const deaths = { a: total((r) => r.deaths.a), b: total((r) => r.deaths.b) };
  const reasons = new Map<string, number>();
  for (const x of all) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1);
  console.log(`
bot:ab — ${args.map} Search & Destroy, ${n} matches of ${args.seconds} s, ${args.perArm} a side`);
  console.log(`  A ${JSON.stringify(args.a)}`);
  console.log(`  B ${JSON.stringify(args.b)}`);
  console.log(`  matches won     A ${winsA}, B ${winsB}, drawn ${n - winsA - winsB}`);
  console.log(
    `  round gap A−B   ${mean.toFixed(2)} per match (95% interval ${(mean - half).toFixed(2)} to ${(mean + half).toFixed(2)})`,
  );
  console.log(
    `  rounds won      A ${won("a", "attacker") + won("a", "defender")} (attacking ${won("a", "attacker")}, defending ${won("a", "defender")}), B ${won("b", "attacker") + won("b", "defender")} (attacking ${won("b", "attacker")}, defending ${won("b", "defender")}) of ${all.length}`,
  );
  console.log(`  plants          ${all.filter((x) => x.planted).length} of ${all.length} rounds`);
  console.log(
    `  round ends      ${[...reasons]
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  console.log(
    `  kills per death A ${(deaths.b / Math.max(1, deaths.a)).toFixed(2)}, B ${(deaths.a / Math.max(1, deaths.b)).toFixed(2)} (deaths A ${deaths.a}, B ${deaths.b}; a side's kills counted as the other side's deaths)`,
  );
  const p = signTest(winsA, winsB);
  console.log(`  wins sign test  p = ${p.toFixed(3)} (matches, two-sided, draws left out)`);
  const shown = (!Number.isNaN(half) && Math.abs(mean) > half) || p < 0.05;
  const stronger = winsA !== winsB ? winsA > winsB : mean > 0;
  console.log(`  verdict         ${shown ? (stronger ? "A is stronger" : "B is stronger") : "no difference shown"}`);
}

function summarize(args: Args, results: MatchResult[]): void {
  if (isTeamMode(args)) {
    summarizeRounds(args, results);
    return;
  }
  const gaps = results.map((r) => r.frags.a - r.frags.b);
  const n = gaps.length;
  const mean = gaps.reduce((s, g) => s + g, 0) / Math.max(1, n);
  const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / Math.max(1, n - 1));
  const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : Number.NaN;
  const winsA = gaps.filter((g) => g > 0).length;
  const winsB = gaps.filter((g) => g < 0).length;
  const total = (pick: (r: MatchResult) => number) => results.reduce((s, r) => s + pick(r), 0);
  console.log(`\nbot:ab — ${args.map} ${args.gametype}, ${n} matches of ${args.seconds} s, ${args.perArm} per arm`);
  console.log(`  A ${JSON.stringify(args.a)}`);
  console.log(`  B ${JSON.stringify(args.b)}`);
  console.log(`  wins            A ${winsA}, B ${winsB}, drawn ${n - winsA - winsB}`);
  console.log(
    `  frag gap A−B    ${mean.toFixed(2)} per match (95% interval ${(mean - half).toFixed(2)} to ${(mean + half).toFixed(2)})`,
  );
  console.log(
    `  frags           A ${total((r) => r.frags.a)}, B ${total((r) => r.frags.b)}; deaths A ${total((r) => r.deaths.a)}, B ${total((r) => r.deaths.b)}`,
  );
  const kinds = ["ra", "ya", "ga", "mega"];
  const perMatch = (arm: "a" | "b", kind: string) =>
    (results.reduce((sum, r) => sum + (r.majors?.[arm][kind] ?? 0), 0) / Math.max(1, n)).toFixed(1);
  console.log(
    `  major items     per match, A–B: ${kinds.map((k) => `${k} ${perMatch("a", k)}–${perMatch("b", k)}`).join(", ")}`,
  );
  for (const arm of ["a", "b"] as const) {
    const time: Record<string, number> = {};
    for (const r of results)
      for (const [id, s] of Object.entries(r.strategies?.[arm] ?? {})) time[id] = (time[id] ?? 0) + s;
    const all = Object.values(time).reduce((sum, s) => sum + s, 0);
    const shares = Object.entries(time)
      .sort((x, y) => y[1] - x[1])
      .map(([id, s]) => `${id} ${Math.round((100 * s) / Math.max(1, all))}%`)
      .join(", ");
    console.log(`  strategy time ${arm.toUpperCase()} ${shares}`);
  }
  const p = signTest(winsA, winsB);
  console.log(`  wins sign test  p = ${p.toFixed(3)} (two-sided, draws left out)`);
  const shown = (!Number.isNaN(half) && Math.abs(mean) > half) || p < 0.05;
  const stronger = winsA !== winsB ? winsA > winsB : mean > 0;
  console.log(`  verdict         ${shown ? (stronger ? "A is stronger" : "B is stronger") : "no difference shown"}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.worker) return worker(args);

  const self = fileURLToPath(import.meta.url);
  const perWorker = Math.ceil(args.matches / args.parallel);
  const results: MatchResult[] = [];
  const passthrough = process.argv.slice(2).filter((_, i, all) => {
    const flag = all[i] === "--matches" || all[i] === "--parallel" || all[i] === "--port" || all[i] === "--first";
    const value = i > 0 && ["--matches", "--parallel", "--port", "--first"].includes(all[i - 1]);
    return !flag && !value;
  });
  const runs: Promise<void>[] = [];
  for (let w = 0; w < args.parallel; w++) {
    const first = w * perWorker;
    const count = Math.min(perWorker, args.matches - first);
    if (count <= 0) break;
    const child = spawn(
      process.execPath,
      [
        process.argv[1],
        self,
        "--",
        ...passthrough,
        "--worker",
        "--matches",
        String(count),
        "--first",
        String(first),
        "--port",
        String(args.port + w * 200),
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "inherit"] },
    );
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.startsWith("RESULT ")) {
          const result = JSON.parse(line.slice(7)) as MatchResult;
          results.push(result);
          const score = result.rounds
            ? `${roundsWon(result, "a")} - ${roundsWon(result, "b")} rounds`
            : `${result.frags.a} - ${result.frags.b}`;
          console.log(
            `  match ${String(result.match + 1).padStart(2)}: A ${score} B  (${results.length}/${args.matches})`,
          );
        }
        newline = buffered.indexOf("\n");
      }
    });
    runs.push(new Promise((resolve) => child.on("close", () => resolve())));
  }
  await Promise.all(runs);
  summarize(args, results);
}

void runCli(main).then(() => process.exit(process.exitCode ?? 0));
