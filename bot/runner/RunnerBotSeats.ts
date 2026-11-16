/**
 * Bot seats the lobby holds itself (`lobby:server --bot-seats`): each invited
 * bot is a BotLobbyClient on an in-process connection to the lobby
 * (LocalSocket), so it joins, readies and carries its rating identity as a
 * bot from the bot server does. Its identity comes from its options
 * (initialBotReference); no brain is built in the lobby. When its match
 * starts, it plays in that game server's match runner (MatchRunnerPool),
 * which loads the map once for the match's bots and exits with the match.
 * No bot server runs.
 */

import type WebSocket from "ws";
import type { BotSeatRequest, LobbyBotSeats } from "../../../../lobby/LobbyServer";
import { getNextBotName } from "../BotConfig";
import { BotLobbyClient, type GameBotLauncher } from "../BotLobbyClient";
import type { IntelStore } from "../intel/IntelStore";
import type { MatchRunnerPool } from "./MatchRunnerPool";

export class RunnerBotSeats implements LobbyBotSeats {
  private readonly seated = new Set<BotLobbyClient>();
  private readonly launch: GameBotLauncher;

  constructor(
    private readonly runners: MatchRunnerPool,
    private readonly secret: string,
    intel?: IntelStore,
  ) {
    this.launch = (serverUrl, options, admissionTicket, events) =>
      runners.launch(serverUrl, options, admissionTicket, {
        ...events,
        onReport: (report) => {
          try {
            intel?.record(report);
          } catch (error) {
            console.warn(`[BotSeats] Could not store ${options.name}'s match report: ${(error as Error).message}`);
          }
        },
      });
  }

  /** Bots seated now. */
  get count(): number {
    return this.seated.size;
  }

  async seat(request: BotSeatRequest): Promise<string> {
    const client = new BotLobbyClient(
      { name: request.name ?? getNextBotName(), difficulty: request.difficulty },
      this.secret,
      this.launch,
      () => request.connect() as unknown as WebSocket,
    );
    client.onDisconnected = () => this.seated.delete(client);
    try {
      await client.connect("local", request.gametype, request.lobbyId, request.inviteToken, request.signal);
    } catch (error) {
      await client.disconnect();
      throw error;
    }
    if (request.signal.aborted) {
      await client.disconnect();
      throw new Error("Bot invite cancelled");
    }
    this.seated.add(client);
    return client.name;
  }

  /** Every seat leaves, and the runners end with their bots. */
  async stop(): Promise<void> {
    await Promise.all([...this.seated].map((client) => client.disconnect()));
    this.seated.clear();
    await this.runners.stop();
  }
}
