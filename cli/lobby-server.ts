/**
 * Lobby Server CLI
 *
 * Starts the WebSocket lobby server.
 *
 * Usage:
 *   npm run lobby:server
 *   npm run lobby:server -- --port 9001
 *   npm run lobby:server -- --data-dir /srv/washoi
 *   npm run lobby:server -- --max-players 64
 */

import { GameServerSpawner } from "../../../lobby/GameServerSpawner";
import { DEFAULT_MAX_PLAYERS, LobbyServer } from "../../../lobby/LobbyServer";
import { MatchResultStore } from "../../../lobby/MatchResultStore";
import { PlayerStore } from "../../../lobby/PlayerStore";
import { RatingStore } from "../../../lobby/RatingStore";
import { loadBotSecret, resolveDataDir } from "../../../lobby/ServerData";
import { describeServerRuntime } from "../../../lobby/ServerRuntime";
import { SettingsStore } from "../../../lobby/SettingsStore";
import { FPS_SERVER_APPLICATION } from "../server/FpsServerApplication";

console.log(`[ServerRuntime] ${describeServerRuntime()}`);

// Parse arguments
const args = process.argv.slice(2);
let port = 9000;
let dataDirArg: string | undefined;
let maxPlayersArg: string | undefined = process.env.SHAG_LOBBY_MAX_PLAYERS;
let resultsInfo = false;
let ratingsInfo = false;
let ratingsVerify = false;
let resultsRecover = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--results-info") resultsInfo = true;
  if (args[i] === "--results-recover") resultsRecover = true;
  if (args[i] === "--ratings-info") ratingsInfo = true;
  if (args[i] === "--ratings-verify") {
    ratingsInfo = true;
    ratingsVerify = true;
  }
  if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  }
  if (args[i] === "--data-dir" && args[i + 1]) {
    dataDirArg = args[i + 1];
    i++;
  }
  if (args[i] === "--max-players" && args[i + 1]) {
    maxPlayersArg = args[i + 1];
    i++;
  }
  if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
Washoi Lobby Server

Usage:
  npm run lobby:server [options]

Options:
  --port <number>     Port to listen on (default: 9000)
  --data-dir <dir>    Server data directory: player accounts (players.db) and
                      the secret shared with the bot server
                      (default: SERVER_DATA_DIR, else ./server-data)
  --max-players <n>   Players online at once, bots not counted; 0 for no cap.
                      Players over it are told to try again later.
                      (default: SHAG_LOBBY_MAX_PLAYERS, else ${DEFAULT_MAX_PLAYERS})
  --help, -h          Show this help
  --results-info     Read result counts/latest result without starting or changing the server
  --ratings-info     Read ranking journal counts and processing reasons without changing storage
  --ratings-verify   Also replay the applied rating journal read-only; fails if unavailable or divergent
  --results-recover  Retry signed result outbox reports into existing storage; requires explicit --data-dir
`);
    process.exit(0);
  }
}

if (resultsRecover) {
  if (!dataDirArg || resultsInfo || ratingsInfo) {
    console.error("Recovery requires an explicit --data-dir and cannot be combined with read-only inspection.");
    process.exit(1);
  }
  const dataDirectory = resolveDataDir(dataDirArg);
  if (RatingStore.inspect(dataDirectory, true).status !== "ready") {
    console.error("Initialized, consistent ranking storage is required for result recovery.");
    process.exit(1);
  }
  const store = MatchResultStore.open(dataDirectory);
  let recoveryExit = 0;
  try {
    store.deliveries.loseBotControl();
    const delivery = store.deliveries.retryAll(0);
    console.log(JSON.stringify({ dataDirectory, delivery }, null, 2));
    recoveryExit = delivery.failed || delivery.rejected ? 1 : 0;
  } finally {
    store.close();
  }
  process.exit(recoveryExit);
}

if (ratingsInfo) {
  const dataDirectory = resolveDataDir(dataDirArg);
  const inspection = RatingStore.inspect(dataDirectory, ratingsVerify);
  console.log(JSON.stringify({ dataDirectory, ratingStore: inspection }, null, 2));
  process.exit(ratingsVerify && inspection.status !== "ready" ? 1 : 0);
}

if (resultsInfo) {
  const dataDirectory = resolveDataDir(dataDirArg);
  console.log(JSON.stringify({ dataDirectory, resultStore: MatchResultStore.inspect(dataDirectory) }, null, 2));
  process.exit(0);
}

// Banner
console.log("═══════════════════════════════════════════════════════");
console.log("  🎮 Washoi Lobby Server");
console.log("═══════════════════════════════════════════════════════");
console.log();

const dataDir = resolveDataDir(dataDirArg);
const players = PlayerStore.open(dataDir);
const results = MatchResultStore.open(dataDir);
const settings = SettingsStore.open(dataDir);
const maxPlayers = maxPlayersArg === undefined || maxPlayersArg === "" ? DEFAULT_MAX_PLAYERS : Number(maxPlayersArg);
if (!Number.isInteger(maxPlayers) || maxPlayers < 0) {
  console.error(`--max-players must be a whole number, 0 for no cap (got "${maxPlayersArg}").`);
  process.exit(1);
}
const server = new LobbyServer(port, new GameServerSpawner(undefined, FPS_SERVER_APPLICATION), {
  botSecret: loadBotSecret(dataDir),
  players,
  results,
  settings,
  maxPlayers,
});
console.log(`  Data directory: ${dataDir}`);

server
  .start()
  .then(() => {
    console.log();
    console.log(`  Clients can connect to: ws://localhost:${port}`);
    console.log("  Press Ctrl+C to stop");
    console.log();
  })
  .catch((err) => {
    console.error("Failed to start lobby server:", err);
    settings.close();
    results.close();
    players.close();
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[LobbyServer] Shutting down...");
  await server.stop();
  settings.close();
  results.close();
  players.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.stop();
  settings.close();
  results.close();
  players.close();
  process.exit(0);
});
