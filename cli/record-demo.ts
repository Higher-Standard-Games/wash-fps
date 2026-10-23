/**
 * record-demo — one-command combat demo recorder.
 *
 * Starts a headless GameServer (map loaded through the pk3 index), connects N AI
 * bots that fight, forces the match Active so recording starts immediately, runs
 * for a fixed duration, then saves the .shagdemo and prints its path.
 *
 * Usage:
 *   npm run demo:record -- --map washoi_dm2 --bots 2 --seconds 30 --gametype duel
 *   npm run demo:record -- --map washoi_dm2 --bots 2 --seconds 60 --models ./models/human
 */

import { MatchPhase } from "@shared/server/gametype";
import { BotServer } from "../bot/BotServer";
import { GameServer, type GameServerConfig } from "../server/GameServer";
import { Amphi } from "../server/gametypes/Amphi";
import type { BaseGametype } from "../server/gametypes/BaseGametype";
import { Deathmatch } from "../server/gametypes/Deathmatch";
import { Duel } from "../server/gametypes/Duel";
import { SearchAndDestroy } from "../server/gametypes/SearchAndDestroy";
import { TeamDeathmatch } from "../server/gametypes/TeamDeathmatch";
import { loadBspCollision } from "./HeadlessMapLoader";

interface Args {
  map: string;
  bots: number;
  seconds: number;
  gametype: string;
  port: number;
  difficulty: string;
  gamePath: string;
  /** Trained weights for the bots, as the bot server's own --models. */
  modelDir?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const a: Args = {
    map: "washoi_dm2",
    bots: 2,
    seconds: 30,
    gametype: "duel",
    port: 7787,
    difficulty: "medium",
    gamePath: "./game",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--map":
        a.map = args[++i];
        break;
      case "--bots":
        a.bots = parseInt(args[++i], 10);
        break;
      case "--seconds":
      case "--secs":
        a.seconds = parseInt(args[++i], 10);
        break;
      case "--gametype":
      case "-g":
        a.gametype = args[++i];
        break;
      case "--port":
        a.port = parseInt(args[++i], 10);
        break;
      case "--difficulty":
      case "-d":
        a.difficulty = args[++i];
        break;
      case "--game":
        a.gamePath = args[++i];
        break;
      case "--models":
        a.modelDir = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: npm run demo:record -- --map <name> --bots <N> --seconds <S> [--gametype duel|amphi|ffa|snd|tdm] [--difficulty easy|medium|hard] [--models <dir>]",
        );
        process.exit(0);
    }
  }
  return a;
}

function makeGametype(name: string): BaseGametype {
  switch (name.toLowerCase()) {
    case "snd":
    case "bomb":
    case "searchanddestroy":
      return new SearchAndDestroy();
    case "tdm":
    case "teamdeathmatch":
      return new TeamDeathmatch();
    case "duel":
    case "1v1":
      return new Duel();
    case "amphi":
      return new Amphi();
    default:
      return new Deathmatch();
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`[Record] map=${args.map} bots=${args.bots} seconds=${args.seconds} gametype=${args.gametype}`);

  if (args.seconds < 12) {
    console.warn(`[Record] Warning: seconds=${args.seconds} is near the 10s minimum — demo may be discarded.`);
  }

  // 1. Map (via pk3 index).
  const bspData = await loadBspCollision(args.map, args.gamePath);
  if (!bspData) {
    console.error(`[Record] Could not load map "${args.map}". Aborting.`);
    process.exit(1);
  }

  // 2. Game server (plain ws:// — no certs needed for local bots).
  const config: GameServerConfig = {
    port: args.port,
    serverName: "demo-record",
    mapName: args.map,
    maxClients: 16,
    tickRate: 125,
    snapshotRate: 60,
    certPath: "",
    keyPath: "",
  };
  const server = new GameServer(config, makeGametype(args.gametype));
  server.setCollisionWorld(bspData.collision);
  server.setSpawnPoints(bspData.spawnPoints, bspData.teamSpawnPoints);
  server.setMapData(bspData.entities, bspData.models);
  server.setPickupItems(bspData.pickups);
  server.setTriggerVolumes(bspData.triggers);
  server.setPickupRespawnTime(15);
  if (bspData.pvs) server.setPVSData(bspData.pvs);
  await server.start();

  const url = `ws://localhost:${args.port}`;
  console.log(`[Record] Server up on ${url}`);

  // 3. Connect AI bots (they load map vision + fight).
  // With --models the bots play with trained weights, which is how a trained
  // model gets watched in a real match before anyone plays against it.
  const botServer = new BotServer(args.port + 100, { modelDir: args.modelDir });
  for (let i = 0; i < args.bots; i++) {
    try {
      if (i > 0) await wait(400);
      const bot = await botServer.addBot(url, { difficulty: args.difficulty });
      console.log(`[Record] Bot ${i + 1}/${args.bots} connected: ${bot.name}`);
    } catch (err) {
      console.error(`[Record] Bot ${i + 1} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // 4. Give bots a moment to join as players, then run the warmup out so the
  //    match starts without waiting the full two minutes. Expiring the timer
  //    rather than jumping phases keeps the normal start: countdown, the
  //    gametype's phase and round hooks, the round reset and respawns.
  await wait(2000);
  const matchState = server.getGametypeController().getMatchState();
  matchState.expireWarmup();
  for (let i = 0; i < 100 && matchState.phase !== MatchPhase.Active; i++) await wait(100);
  console.log(`[Record] Match ${matchState.phase === MatchPhase.Active ? "live" : "not live yet"} — recording…`);

  // 5. Play for the requested duration.
  console.log(`[Record] Recording ${args.seconds}s of play…`);
  await wait(args.seconds * 1000);

  // 6. Save the demo and report the path.
  const filepath = await server.stopRecording();
  await server.stop();

  if (filepath) {
    console.log(`\n[Record] ✓ Demo saved: ${filepath}`);
  } else {
    console.warn(`\n[Record] No demo written (match too short, or no frames recorded).`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[Record] Fatal:", err);
  process.exit(1);
});
