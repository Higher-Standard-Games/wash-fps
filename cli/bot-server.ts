/**
 * Bot Intelligence Server CLI
 *
 * Starts the BIS process that manages bot clients.
 * Bots connect to game servers as real clients via WebSocket.
 *
 * Usage:
 *   npx vite-node src/games/fps/cli/bot-server.ts
 *   npx vite-node src/games/fps/cli/bot-server.ts --port 9100
 *   npx vite-node src/games/fps/cli/bot-server.ts --auto ws://localhost:7777 --count 3
 *
 * The bot server exposes a control WebSocket API on 127.0.0.1 at its port.
 * The lobby connects here to add bots, sending the secret it shares with the
 * bot server (BOT_SECRET, or <data-dir>/bot-secret).
 *
 * For quick testing, use --auto to spawn bots immediately:
 *   --auto <gameServerUrl>   Auto-connect bots to this game server
 *   --count <N>              Number of bots to auto-spawn (default: 3)
 *   --difficulty <level>     Difficulty: easy, medium, hard, insane (default: medium)
 */

import { runCli } from "../../../cli/_runCli";
import { loadBotSecret, resolveDataDir } from "../../../lobby/ServerData";
import { BotServer } from "../bot/BotServer";

// ── Parse Arguments ─────────────────────────────────────────────────────

interface BotServerArgs {
  port: number;
  autoConnect?: string;
  autoCount: number;
  difficulty: string;
  lobbyUrl?: string;
  gametype: string;
  modelDir?: string;
  dataDir?: string;
}

function parseArgs(): BotServerArgs {
  // Filter out '--' separators injected by npm/pnpm run
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const config: BotServerArgs = {
    port: 9100,
    autoCount: 3,
    difficulty: "medium",
    gametype: "duel",
  };

  let namedFlagFound = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i], 10);
        namedFlagFound = true;
        break;
      case "--auto":
        config.autoConnect = args[++i];
        namedFlagFound = true;
        break;
      case "--count":
        config.autoCount = parseInt(args[++i], 10);
        namedFlagFound = true;
        break;
      case "--difficulty":
      case "-d":
        config.difficulty = args[++i];
        namedFlagFound = true;
        break;
      case "--lobby":
        config.lobbyUrl = args[++i];
        namedFlagFound = true;
        break;
      case "--gametype":
      case "-g":
        config.gametype = args[++i];
        namedFlagFound = true;
        break;
      case "--models":
        config.modelDir = args[++i];
        namedFlagFound = true;
        break;
      case "--data-dir":
        config.dataDir = args[++i];
        namedFlagFound = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  // Positional fallback: npm/pnpm sometimes strips flag names
  // Treat positional args as: [url] [gametype] [count] [difficulty]
  if (!namedFlagFound && args.length > 0) {
    console.log(`[BIS] Note: Using positional arg parsing (flags were stripped by npm)`);
    console.log(`[BIS] Raw args: ${args.join(" ")}`);
    if (args[0]?.startsWith("ws://") || args[0]?.startsWith("wss://")) {
      config.lobbyUrl = args[0];
    }
    if (args[1]) config.gametype = args[1];
    if (args[2]) config.autoCount = parseInt(args[2], 10);
    if (args[3]) config.difficulty = args[3];
  }

  return config;
}

function printHelp(): void {
  console.log(`
Bot Intelligence Server (BIS)

Usage: npx vite-node src/games/fps/cli/bot-server.ts [options]

Options:
  --port <n>          Control API port (default: 9100)
  --auto <url>        Auto-connect bots to a game server URL (direct)
  --lobby <url>       Auto-connect bots through lobby server (lobby flow)
  --gametype <id>     Gametype for lobby queue: duel, tdm, ffa (default: duel)
  --count <n>         Number of bots to auto-spawn (default: 3)
  --difficulty <lvl>  Bot difficulty: easy, medium, hard, insane (default: medium)
  --models <dir>       Path to TF.js model directory for HybridBrain AI
  --data-dir <dir>    Server data directory holding the shared bot secret
                      (default: SERVER_DATA_DIR, else ./server-data)
  --help, -h          Show this help

Examples:
  # Direct connect to game server (game must already be running)
  npx vite-node src/games/fps/cli/bot-server.ts -- --auto ws://localhost:7777 --count 4

  # Through lobby (bot joins lobby, readies up, transitions to game)
  npx vite-node src/games/fps/cli/bot-server.ts -- --lobby ws://localhost:9000 --gametype duel
  npx vite-node src/games/fps/cli/bot-server.ts -- --lobby ws://localhost:9000 --gametype duel --count 1
`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();

  console.log("");
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║       Bot Intelligence Server (BIS)           ║");
  console.log("║         Phase 1: State Machine AI             ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log("");
  console.log(`[BIS] Control API port: ${config.port}`);
  console.log(`[BIS] Default difficulty: ${config.difficulty}`);
  console.log("");

  const server = new BotServer(config.port, {
    secret: loadBotSecret(resolveDataDir(config.dataDir)),
    modelDir: config.modelDir,
  });
  await server.start();

  // Auto-connect through lobby if --lobby flag
  if (config.lobbyUrl) {
    console.log(
      `[BIS] Lobby mode: connecting ${config.autoCount} bot(s) through ${config.lobbyUrl} (${config.gametype})...`,
    );
    console.log("");

    for (let i = 0; i < config.autoCount; i++) {
      try {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
        await server.addLobbyBot(config.lobbyUrl, config.gametype, {
          difficulty: config.difficulty,
          modelDir: config.modelDir,
        });
      } catch (err) {
        console.error(`[BIS] Failed to spawn lobby bot ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log("");
    console.log(`[BIS] Lobby auto-connect complete. ${server.getStatus().length} bots active.`);
  }

  // Auto-connect bots directly if --auto flag
  if (config.autoConnect) {
    console.log(`[BIS] Auto-connecting ${config.autoCount} bots to ${config.autoConnect}...`);
    console.log("");

    for (let i = 0; i < config.autoCount; i++) {
      try {
        // Stagger connections by 500ms to avoid overwhelming the game server
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
        await server.addBot(config.autoConnect, {
          difficulty: config.difficulty,
          modelDir: config.modelDir,
        });
      } catch (err) {
        console.error(`[BIS] Failed to spawn bot ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log("");
    console.log(`[BIS] Auto-connect complete. ${server.getStatus().length} bots active.`);
  }

  // ── stdin command handler ───────────────────────────────────────
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "add":
      case "addbot": {
        const url = parts[1] || config.autoConnect || "ws://localhost:7777";
        const diff = parts[2] || config.difficulty;
        try {
          const bot = await server.addBot(url, { difficulty: diff });
          console.log(`[BIS] Added bot: ${bot.name} → ${url}`);
        } catch (err) {
          console.error(`[BIS] Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case "lobby": {
        const url = parts[1] || config.lobbyUrl || "ws://localhost:9000";
        const gametype = parts[2] || config.gametype;
        const diff = parts[3] || config.difficulty;
        try {
          const lb = await server.addLobbyBot(url, gametype, { difficulty: diff });
          console.log(`[BIS] Lobby bot: ${lb.name} → ${url} (${gametype})`);
        } catch (err) {
          console.error(`[BIS] Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case "remove": {
        if (parts[1] === "all") {
          const count = await server.removeAllBots();
          console.log(`[BIS] Removed ${count} bots`);
        } else if (parts[1]) {
          const removed = await server.removeBot(parts[1]);
          console.log(removed ? `[BIS] Removed bot ${parts[1]}` : `[BIS] Bot not found`);
        }
        break;
      }

      case "status":
      case "list": {
        const bots = server.getStatus();
        if (bots.length === 0) {
          console.log("[BIS] No active bots");
        } else {
          console.log(`[BIS] Active bots (${bots.length}):`);
          for (const bot of bots) {
            console.log(`  ${bot.name} [${bot.state}/${bot.brainState}] → ${bot.server}`);
          }
        }
        break;
      }

      case "help": {
        console.log("[BIS] Commands:");
        console.log("  add [url] [difficulty]          - Add bot directly to game server");
        console.log("  lobby [url] [gametype] [diff]   - Add bot through lobby");
        console.log("  remove <botId|all>              - Remove bot(s)");
        console.log("  status                          - Show bot status");
        console.log("  help                            - Show this help");
        break;
      }

      default:
        console.log(`[BIS] Unknown command: ${cmd}. Type 'help' for available commands.`);
    }
  });

  console.log("[BIS] Commands: add, lobby, remove, status, help");
  console.log("[BIS] Press Ctrl+C to stop");
  console.log("");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[BIS] Shutting down...");
    rl.close();
    await server.stop();
    console.log("[BIS] Goodbye!");
    process.exit(0);
  });
}

// Run
void runCli(main);
