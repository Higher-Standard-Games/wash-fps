/**
 * Headless Network Server CLI v2
 *
 * Thin CLI wrapper around GameServer.
 * Handles argument parsing, BSP loading, and bootstrapping.
 *
 * Usage:
 *   npx vite-node src/games/fps/cli/headless-netserver-v2.ts --port 7777 --map washoi_dm2
 *   npx vite-node src/games/fps/cli/headless-netserver-v2.ts --help
 *
 * Requirements:
 *   - TLS certificates for WebTransport (use mkcert for development)
 *   - @fails-components/webtransport or @aspect-build/webtransport
 */

import * as fs from "node:fs";
import { runCli } from "../../../cli/_runCli";
import { markServerMemory } from "../../../cli/ServerMemoryMarker";
import { ADMIT_ACK_PREFIX, ADMIT_COMMAND, type AdmissionManifest } from "../../../engine/server/network/MatchAdmission";
import { signMatchResult } from "../../../engine/server/network/MatchResultReport";
import { persistFinalResult } from "../../../lobby/ResultOutbox";
import { describeServerRuntime } from "../../../lobby/ServerRuntime";
import { DEFAULT_PHYSICS_TICK_RATE } from "../../../shared/server/simulation/physics/constants";
import { GameServer, type GameServerConfig } from "../server/GameServer";
import { Amphi } from "../server/gametypes/Amphi";
import type { BaseGametype } from "../server/gametypes/BaseGametype";
import { Deathmatch } from "../server/gametypes/Deathmatch";
import { Duel } from "../server/gametypes/Duel";
import { SearchAndDestroy } from "../server/gametypes/SearchAndDestroy";
import { TeamDeathmatch } from "../server/gametypes/TeamDeathmatch";
import { loadBspCollision } from "./HeadlessMapLoader";

markServerMemory("modules-ready");

// ============================================================================
// Configuration
// ============================================================================

function parseArgs(): GameServerConfig & { gamePath: string; gametype: string } {
  const args = process.argv.slice(2);
  const config = {
    port: 7777,
    serverName: "SHAG Server v2",
    mapName: "washoi_dm2",
    maxClients: 16,
    tickRate: DEFAULT_PHYSICS_TICK_RATE,
    snapshotRate: 60,
    gamePath: "./game",
    certPath: process.env.SHAG_GAME_CERT_PATH || "./certs/localhost.pem",
    keyPath: process.env.SHAG_GAME_KEY_PATH || "./certs/localhost-key.pem",
    gametype: "Deathmatch",
    shutdownOnEmpty: false,
    singleMatch: false,
    privateMatch: false,
    trainingDemo: undefined as string | undefined,
  };

  let positionalPos = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--map=")) {
      config.mapName = arg.substring(6);
      continue;
    }

    switch (arg) {
      case "--port":
        config.port = parseInt(args[++i], 10);
        break;
      case "--name":
      case "--hostname":
        config.serverName = args[++i];
        break;
      case "--map":
        config.mapName = args[++i];
        break;
      case "--gametype":
      case "-g":
        config.gametype = args[++i];
        break;
      case "--max":
      case "--maxclients":
        config.maxClients = parseInt(args[++i], 10);
        break;
      case "--snapshotrate":
        config.snapshotRate = parseInt(args[++i], 10);
        break;
      case "--game":
        config.gamePath = args[++i];
        break;
      case "--cert":
        config.certPath = args[++i];
        break;
      case "--key":
        config.keyPath = args[++i];
        break;
      case "--shutdown":
        config.shutdownOnEmpty = true;
        break;
      case "--single-match":
        config.singleMatch = true;
        break;
      case "--private-match":
        config.privateMatch = true;
        break;
      case "--training-demo":
        config.trainingDemo = args[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        return process.exit(0);
      default:
        if (!arg.startsWith("-")) {
          const prev = i > 0 ? args[i - 1] : "";
          const isValueForPrev = prev.startsWith("-") && prev !== "--" && !prev.includes("=");

          if (!isValueForPrev || prev === "--") {
            if (positionalPos === 0) {
              config.mapName = arg;
              positionalPos++;
            } else if (positionalPos === 1) {
              config.gametype = arg;
              positionalPos++;
            }
          }
        }
        break;
    }
  }

  const rawAdmission = process.env.SHAG_MATCH_ADMISSION;
  const matchAdmission = rawAdmission ? (JSON.parse(rawAdmission) as AdmissionManifest) : undefined;
  if (matchAdmission && (!matchAdmission.matchId || !Array.isArray(matchAdmission.grants))) {
    throw new Error("Invalid match admission manifest");
  }
  const resultSecret = process.env.SHAG_MATCH_RESULT_SECRET;
  const resultOutbox = process.env.SHAG_MATCH_RESULT_OUTBOX;
  if (matchAdmission && !resultSecret) throw new Error("Missing match result secret");
  return {
    ...config,
    matchAdmission,
    matchGametype: config.gametype,
    onFinalResult:
      matchAdmission && resultSecret
        ? (report: Parameters<typeof signMatchResult>[0]) => {
            const line = signMatchResult(report, resultSecret);
            if (resultOutbox) {
              try {
                persistFinalResult(resultOutbox, line);
              } catch {
                console.error(
                  "[GameServer] Final report outbox failed; restart recovery is unavailable for this report.",
                );
              }
            }
            process.stdout.write(`${line}\n`);
          }
        : undefined,
  };
}

function printHelp(): void {
  console.log(`
SHAG Dedicated Server v2 (Next-Gen Architecture)

Usage: npx vite-node src/games/fps/cli/headless-netserver-v2.ts [options]

Options:
  --port <n>             Server port (default: 7777)
  --map <name>           Map to load (default: washoi_dm2)
  --gametype <name>      Gametype (Deathmatch, TeamDeathmatch, Duel, Amphi, SnD)
  --private-match        Mark recorded demos as private (set by the lobby)
  --name <name>          Server name
  --max <n>              Max clients (default: 16)
  --snapshotrate <n>     Snapshot rate in Hz (default: 60)
  --game <path>          Game data path (default: ./game)
  --cert <path>          TLS certificate for wss:// (default: ./certs/localhost.pem)
  --key <path>           TLS private key for wss:// (default: ./certs/localhost-key.pem)
  --shutdown             Auto-exit when all clients disconnect
  --training-demo <name> Record a training demo: warmup never ends, a frame per tick,
                         saved to public/data/demos/training/<map>_<name>.shagdemo
  --single-match         One match per server: post-game is terminal, players
                         return to the lobby, bots are released, process exits
  --help, -h             Show this help

TLS:
  With both certificate files present the server accepts wss://; without
  them it serves plain ws://. For development certificates:
    1. Install mkcert: https://github.com/FiloSottile/mkcert
    2. Run: mkcert -install && mkcert localhost
    3. Move localhost.pem and localhost-key.pem to ./certs/

Examples:
  npx vite-node src/games/fps/cli/headless-netserver-v2.ts --map washoi_dm2
  npx vite-node src/games/fps/cli/headless-netserver-v2.ts --port 7777 --map washoi_dm2

Environment:
  SHAG_GAME_CERT_PATH    Default TLS certificate path for spawned game servers
  SHAG_GAME_KEY_PATH     Default TLS private key path for spawned game servers
`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();
  console.log(`[ServerRuntime] ${describeServerRuntime()}`);

  console.log("");
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SHAG Dedicated Server v2 (Next-Gen)       ║");
  console.log("║         WebTransport / QUIC Edition           ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log("");
  console.log(`[Server] Name: ${config.serverName}`);
  console.log(`[Server] Port: ${config.port}`);
  console.log(`[Server] Map: ${config.mapName}`);
  console.log(`[Server] Max clients: ${config.maxClients}`);
  console.log(`[Server] Tick rate: ${config.tickRate}Hz`);
  console.log(`[Server] TLS Cert: ${config.certPath}`);
  if (config.shutdownOnEmpty) {
    console.log(`[Server] Shutdown mode: auto-exit when empty`);
  }
  if (config.singleMatch) {
    console.log(`[Server] Match flow: single — one match, then players return to the lobby`);
  }
  console.log("");

  // Check for TLS certificates
  if (!fs.existsSync(config.certPath) || !fs.existsSync(config.keyPath)) {
    console.log("[Server] WARNING: TLS certificates not found.");
    console.log("[Server] Direct wss:// requires TLS. Falling back to plain ws:// for this server.");
    console.log("");
    console.log("[Server] To generate certificates for development:");
    console.log("  1. Install mkcert: https://github.com/FiloSottile/mkcert");
    console.log("  2. Run: mkcert -install");
    console.log("  3. Run: mkcert localhost");
    console.log("  4. Create ./certs/ directory and move the .pem files there");
    console.log("");
    config.certPath = "";
    config.keyPath = "";
  }

  // Load BSP
  const bspData = await loadBspCollision(config.mapName, config.gamePath);
  config.matchMapDigest = bspData?.bspSha256;

  // Create game server with selected gametype
  let gametypeInstance: BaseGametype;
  switch (config.gametype.toLowerCase()) {
    case "amphi":
      gametypeInstance = new Amphi();
      break;
    case "snd":
    case "bomb":
    case "searchanddestroy":
      gametypeInstance = new SearchAndDestroy();
      break;
    case "tdm":
    case "teamdeathmatch":
      gametypeInstance = new TeamDeathmatch();
      break;
    case "duel":
    case "1v1":
      gametypeInstance = new Duel();
      break;
    default:
      gametypeInstance = new Deathmatch();
      break;
  }
  console.log(`[Server] Gametype: ${gametypeInstance.name}`);

  if (config.trainingDemo) {
    // A training run is one player practising a trick: stay in warmup for good,
    // and send a snapshot every tick so each demo frame holds exactly one input.
    process.env.SHAG_WARMUP = "0";
    config.snapshotRate = config.tickRate;
    console.log(`[Server] Training demo: ${config.trainingDemo}`);
  }

  const server = new GameServer(config, gametypeInstance);

  if (bspData) {
    server.setCollisionWorld(bspData.collision);
    server.setSpawnPoints(bspData.spawnPoints, bspData.teamSpawnPoints);
    server.setMapData(bspData.entities, bspData.models);
    server.setPickupItems(bspData.pickups);
    server.setTriggerVolumes(bspData.triggers);
    server.setPickupRespawnTime(15); // weapons: 15s (armor 25s+15s delay, health 20s, mega 60s are PickupSystem defaults)
    if (bspData.pvs) {
      server.setPVSData(bspData.pvs);
    }
  } else {
    console.log("[Server] Running without BSP collision (open space mode)");
  }

  // Start server
  await server.start();
  markServerMemory("listening", { map: config.mapName, port: config.port, bspSha256: bspData?.bspSha256 });

  console.log("");
  console.log(`[Server] ✓ Ready for connections`);
  console.log("[Server] Commands: spawn_bots <N>, status, help");
  console.log("[Server] Press Ctrl+C to stop");
  console.log("");

  // ── stdin command handler ──────────────────────────────────────
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "quit":
        void shutdown();
        break;
      case "spawn_bots":
      case "bots": {
        const count = parseInt(parts[1] || "3", 10);
        if (Number.isNaN(count) || count < 1 || count > 32) {
          console.log("[Server] Usage: spawn_bots <1-32>");
          break;
        }
        server.spawnBots(count);
        break;
      }
      case "status": {
        console.log(`[Server] Map: ${config.mapName}, Tick rate: ${config.tickRate}Hz`);
        break;
      }
      case ADMIT_COMMAND: {
        // The lobby adding a seat for a player dropping in. The acknowledgement
        // is what lets it hand the player their ticket.
        let grants: unknown;
        try {
          grants = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
        } catch {
          grants = null;
        }
        const seatId = Array.isArray(grants) ? (grants[0] as { seatId?: unknown })?.seatId : undefined;
        if (Array.isArray(grants) && typeof seatId === "string" && server.admitSeat(grants)) {
          console.log(`${ADMIT_ACK_PREFIX}${seatId}`);
        } else {
          console.log("[Server] Refused a drop-in seat");
        }
        break;
      }
      case "help": {
        console.log("[Server] Commands:");
        console.log("  spawn_bots <N>  - Spawn N bot entities at spawn points");
        console.log("  status          - Show server status");
        console.log("  quit            - Save recordings and stop the server");
        console.log("  help            - Show this help");
        break;
      }
      default:
        console.log(`[Server] Unknown command: ${cmd}. Type 'help' for available commands.`);
    }
  });

  // Graceful shutdown
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\n[Server] Shutting down...");
    rl.close();
    await server.stop();
    console.log("[Server] Goodbye!");
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// Run
void runCli(main);
