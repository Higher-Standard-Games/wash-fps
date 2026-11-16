/**
 * Messages between the bot server and a match runner, a child process that
 * plays one match's bots (MatchRunnerPool starts it, cli/bot-runner.ts is its
 * entry). They travel over the child's IPC channel as structured clones.
 */

import type { BotReference } from "../../../../shared/ranking/BotReference";
import type { BotOptions } from "../BotConfig";
import type { MatchReport } from "../intel/IntelStore";

/** The bot server's requests to a runner. */
export type ToRunner =
  /** Connect a bot to the runner's game server. */
  | { type: "add"; id: string; options: BotOptions; admissionTicket?: string }
  /** Disconnect a bot. */
  | { type: "remove"; id: string };

/** A runner's reports, by the id its bot was added under. */
export type FromRunner =
  | { type: "added"; id: string; playerId: string | null }
  | { type: "failed"; id: string; error: string }
  | { type: "reference"; id: string; reference: BotReference }
  | { type: "report"; id: string; report: MatchReport }
  | { type: "disconnected"; id: string };
