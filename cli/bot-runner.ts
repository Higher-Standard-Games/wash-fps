/**
 * bot-runner — one match's bots, in a process of their own.
 *
 * The bot server starts one per game server (bot/runner/MatchRunnerPool.ts)
 * and sends it the bots to connect over the IPC channel; the runner loads the
 * map's vision and nav graph once for all of them, plays them, and reports
 * each bot's rating identity, match report and disconnection back. It exits
 * once its last bot has left (after a short grace for a bot still coming),
 * when it has had none for RUNNER_IDLE_MS, or when the bot server goes.
 *
 * Not for starting by hand: it needs the IPC channel of the bot server.
 * Usage (by MatchRunnerPool): bot-runner --server ws://127.0.0.1:7777
 */

import type { BotClient } from "../bot/BotClient";
import { BotServer } from "../bot/BotServer";
import type { FromRunner, ToRunner } from "../bot/runner/MatchRunnerProtocol";
import { debugEnabled, debugLog } from "../server/DebugLog";

/** A runner with no bots exits after this long, ms. */
const RUNNER_IDLE_MS = 30_000;
/** After its last bot leaves, a runner waits this long for another before exiting, ms. */
const RUNNER_LAST_BOT_GRACE_MS = 3_000;
/** With SHAG_DEBUG=memory, the runner logs its memory this often, ms. */
const MEMORY_LOG_MS = 10_000;

function serverUrl(): string {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const at = args.indexOf("--server");
  const url = at >= 0 ? args[at + 1] : undefined;
  if (!url) throw new Error("bot-runner needs --server <game server url>");
  return url;
}

function main(): void {
  if (!process.send) throw new Error("bot-runner is started by the bot server, over an IPC channel");
  const url = serverUrl();
  const server = new BotServer(0);
  const bots = new Map<string, BotClient>();
  let adding = 0;
  let closing = false;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  const report = (message: FromRunner) => {
    if (process.connected) process.send?.(message);
  };

  const exitLater = (ms: number) => {
    if (exitTimer) clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      if (bots.size === 0 && adding === 0) void shutDown(0);
    }, ms);
  };
  const shutDown = async (code: number) => {
    if (closing) return;
    closing = true;
    // New bots go to a new runner from here on; any already sent are refused below
    report({ type: "closing" });
    await server.removeAllBots();
    process.exit(code);
  };

  const add = async (message: Extract<ToRunner, { type: "add" }>) => {
    if (closing) {
      report({ type: "failed", id: message.id, error: "Match runner closing" });
      return;
    }
    if (exitTimer) clearTimeout(exitTimer);
    exitTimer = null;
    adding++;
    try {
      const bot = await server.addBot(url, message.options, message.admissionTicket);
      bots.set(message.id, bot);
      report({ type: "reference", id: message.id, reference: bot.ratingReference });
      bot.on("ratingReferenceChanged", (reference) => report({ type: "reference", id: message.id, reference }));
      bot.on("matchReport", (matchReport) => report({ type: "report", id: message.id, report: matchReport }));
      bot.on("disconnected", () => {
        if (!bots.delete(message.id)) return;
        report({ type: "disconnected", id: message.id });
        if (bots.size === 0) exitLater(RUNNER_LAST_BOT_GRACE_MS);
      });
      report({ type: "added", id: message.id, playerId: bot.playerId || null });
    } catch (error) {
      report({ type: "failed", id: message.id, error: error instanceof Error ? error.message : String(error) });
      if (bots.size === 0) exitLater(RUNNER_LAST_BOT_GRACE_MS);
    } finally {
      adding--;
    }
  };

  process.on("message", (message: ToRunner) => {
    if (message.type === "add") void add(message);
    else if (message.type === "remove") {
      const bot = bots.get(message.id);
      if (!bot) return;
      bots.delete(message.id);
      void bot.dispose().finally(() => {
        if (bots.size === 0) exitLater(RUNNER_LAST_BOT_GRACE_MS);
      });
    }
  });
  // The bot server is gone: so is the match's reason to play.
  process.on("disconnect", () => void shutDown(0));
  exitLater(RUNNER_IDLE_MS);
  // SHAG_DEBUG=memory: what the match costs, every MEMORY_LOG_MS
  if (debugEnabled("memory")) {
    const mb = (n: number) => Math.round(n / 1048576);
    setInterval(() => {
      const m = process.memoryUsage();
      debugLog(
        "memory",
        () =>
          `[BotRunner] ${bots.size} bots: rss ${mb(m.rss)} MB, heap ${mb(m.heapUsed)} of ${mb(m.heapTotal)} MB, buffers ${mb(m.external)} MB`,
      );
    }, MEMORY_LOG_MS).unref();
  }
  console.log(`[BotRunner] ${process.pid} playing for ${url}`);
}

main();
