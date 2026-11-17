/**
 * Match runners: a child process per game server that plays that match's bots
 * (cli/bot-runner.ts). The bot server keeps the bots' lobby seats; when a
 * match starts, each bot's game connection goes to its match's runner, which
 * loads the map once for all of them and exits when its last bot leaves. Two
 * matches never share a runner, so one match's nav build, slow decision or
 * crash touches only its own bots, and a match's memory goes when it ends.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { BotReference } from "../../../../shared/ranking/BotReference";
import type { BotOptions } from "../BotConfig";
import type { MatchReport } from "../intel/IntelStore";
import type { FromRunner, ToRunner } from "./MatchRunnerProtocol";

/** The runner's file in the bundled bot server, built beside it by build-servers.mjs. */
const RUNNER_FILE = "bot-runner.mjs";

/**
 * A runner's heap. Its bots keep about 75 MB alive but make garbage fast, and
 * left to itself V8 grows the young generation to collect less often: a
 * 10-bot washoi_snd1 runner held 420 MB of RSS with a heap of 220-290 MB.
 * With a 4 MB young generation it holds 173 MB, for the same snapshot cost;
 * the old generation is capped well above what the bots keep, so a runner
 * that outgrows it ends its own match, not the bot server.
 */
export const RUNNER_NODE_FLAGS = ["--max-semi-space-size=4", "--max-old-space-size=256"];

/** How to start a runner: the executable and its arguments before the runner's own. */
export interface RunnerCommand {
  file: string;
  args: string[];
}

/**
 * The runner beside the bundled bot server, or, run from source with
 * vite-node, the runner's source through the same vite-node; null when
 * neither is there.
 */
export function runnerCommand(): RunnerCommand | null {
  const bundled = fileURLToPath(new URL(`./${RUNNER_FILE}`, import.meta.url));
  if (fs.existsSync(bundled)) return { file: process.execPath, args: [...RUNNER_NODE_FLAGS, bundled] };
  const viteNode = process.argv[1];
  const source = fileURLToPath(new URL("../../cli/bot-runner.ts", import.meta.url));
  if (viteNode?.endsWith("vite-node.mjs") && fs.existsSync(source)) {
    return { file: process.execPath, args: [...RUNNER_NODE_FLAGS, viteNode, source, "--"] };
  }
  return null;
}

/** What a runner reports about one bot, to the seat that asked for it. */
export interface RunnerBotEvents {
  /** The bot's rating identity, when it is first known in the runner and whenever it changes. */
  onReference(reference: BotReference): void;
  onReport(report: MatchReport): void;
  /** The bot left its game server, or its runner ended. */
  onDisconnected(): void;
}

/** A bot playing in a runner. */
export interface RunnerBot {
  readonly id: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly playerId: string | null;
  /** Disconnect the bot; its runner exits once it has none left. */
  dispose(): Promise<void>;
}

interface RunnerProcess {
  child: ChildProcess;
  serverUrl: string;
  bots: Map<string, { bot: RunnerBot; events: RunnerBotEvents }>;
  pending: Map<string, { resolve: (playerId: string | null) => void; reject: (error: Error) => void }>;
  /** It said it is ending, or it has exited: new bots go to a new runner. */
  closing: boolean;
}

let nextId = 0;

export class MatchRunnerPool {
  private readonly runners = new Map<string, RunnerProcess>();

  constructor(private readonly command: RunnerCommand) {}

  /** Runners alive, with their game server and bots, for status. */
  status(): { serverUrl: string; pid: number | undefined; bots: string[] }[] {
    return [...this.runners.values()].map((runner) => ({
      serverUrl: runner.serverUrl,
      pid: runner.child.pid,
      bots: [...runner.bots.values()].map(({ bot }) => bot.name),
    }));
  }

  /**
   * Play `options`' bot on `serverUrl`, in that game server's runner, started
   * if it has none. A runner ending as the bot arrives (its last bot just
   * left, and a new match took the same address) refuses it; the bot then
   * goes to a new runner.
   */
  async launch(
    serverUrl: string,
    options: BotOptions,
    admissionTicket: string | undefined,
    events: RunnerBotEvents,
  ): Promise<RunnerBot> {
    const current = this.runners.get(serverUrl);
    const runner = current && !current.closing ? current : this.start(serverUrl);
    try {
      return await this.launchIn(runner, serverUrl, options, admissionTicket, events);
    } catch (error) {
      if (!runner.closing) throw error;
      const fresh = this.runners.get(serverUrl);
      return this.launchIn(
        fresh && !fresh.closing ? fresh : this.start(serverUrl),
        serverUrl,
        options,
        admissionTicket,
        events,
      );
    }
  }

  private async launchIn(
    runner: RunnerProcess,
    serverUrl: string,
    options: BotOptions,
    admissionTicket: string | undefined,
    events: RunnerBotEvents,
  ): Promise<RunnerBot> {
    const id = `runner_bot_${++nextId}`;
    let playerId: string | null = null;
    const bot: RunnerBot = {
      id,
      name: options.name,
      serverUrl,
      get playerId() {
        return playerId;
      },
      dispose: async () => {
        if (!runner.bots.delete(id)) return;
        send(runner, { type: "remove", id });
      },
    };
    runner.bots.set(id, { bot, events });
    try {
      playerId = await new Promise<string | null>((resolve, reject) => {
        runner.pending.set(id, { resolve, reject });
        send(runner, { type: "add", id, options, admissionTicket });
      });
    } catch (error) {
      runner.bots.delete(id);
      throw error;
    }
    return bot;
  }

  /** End every runner; their bots disconnect with them. */
  async stop(): Promise<void> {
    const exits = [...this.runners.values()].map(
      (runner) =>
        new Promise<void>((resolve) => {
          if (runner.child.exitCode !== null) return resolve();
          runner.child.once("exit", () => resolve());
          runner.child.kill();
        }),
    );
    await Promise.all(exits);
  }

  private start(serverUrl: string): RunnerProcess {
    const child = spawn(this.command.file, [...this.command.args, "--server", serverUrl], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
    });
    const runner: RunnerProcess = { child, serverUrl, bots: new Map(), pending: new Map(), closing: false };
    this.runners.set(serverUrl, runner);
    console.log(`[BotServer] Match runner ${child.pid} started for ${serverUrl}`);
    child.on("message", (message: FromRunner) => this.receive(runner, message));
    const ended = (why: string) => {
      runner.closing = true;
      if (this.runners.get(serverUrl) === runner) this.runners.delete(serverUrl);
      for (const { reject } of runner.pending.values()) reject(new Error(`Match runner ${why}`));
      runner.pending.clear();
      for (const { events } of runner.bots.values()) events.onDisconnected();
      runner.bots.clear();
    };
    child.on("exit", (code, signal) => {
      console.log(`[BotServer] Match runner ${child.pid} for ${serverUrl} exited (${signal ?? code})`);
      ended("exited");
    });
    child.on("error", (error) => {
      console.error(`[BotServer] Match runner for ${serverUrl}: ${error.message}`);
      // A runner that never started sends no exit: its bots would wait for ever
      if (child.pid === undefined) ended("could not start");
    });
    return runner;
  }

  private receive(runner: RunnerProcess, message: FromRunner): void {
    if (message.type === "closing") {
      runner.closing = true;
      if (this.runners.get(runner.serverUrl) === runner) this.runners.delete(runner.serverUrl);
      return;
    }
    const waiting = runner.pending.get(message.id);
    const seat = runner.bots.get(message.id);
    switch (message.type) {
      case "added":
        runner.pending.delete(message.id);
        waiting?.resolve(message.playerId);
        break;
      case "failed":
        runner.pending.delete(message.id);
        waiting?.reject(new Error(message.error));
        break;
      case "reference":
        seat?.events.onReference(message.reference);
        break;
      case "report":
        seat?.events.onReport(message.report);
        break;
      case "disconnected":
        if (runner.bots.delete(message.id)) seat?.events.onDisconnected();
        break;
    }
  }
}

function send(runner: RunnerProcess, message: ToRunner): void {
  if (runner.child.connected) runner.child.send(message);
}
