/**
 * A campaign boss's own size and slime immunity come with the match that
 * gives them, and go with it: the bot's next match starts without them.
 */
import { describe, expect, it, vi } from "vitest";
import { BotLobbyClient } from "../BotLobbyClient";

// biome-ignore lint/suspicious/noExplicitAny: reaches the client's message handler and options
type Inner = any;

function connect(campaign?: object) {
  return {
    type: "lobby:connect",
    serverUrl: "ws://127.0.0.1:7777",
    map: "washoi_amphi1",
    ...(campaign ? { campaign } : {}),
  };
}

describe("a lobby bot's campaign options", () => {
  it("are this match's alone", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client: Inner = new BotLobbyClient({ name: "Siege_Bot", difficulty: "hard" }, "secret");
    client._connectToGameServer = vi.fn(async () => {});
    client._handleMessage(
      connect({
        missionId: "siege-breaker",
        models: { ally: "robot", enemy: "robot" },
        botScales: { Siege_Bot: 2.5 },
        slimeImmune: ["Siege_Bot"],
      }),
    );
    expect(client._botOptions).toMatchObject({ bodyScale: 2.5, liquidImmune: true });
    client._handleMessage(connect());
    expect(client._botOptions.bodyScale).toBeUndefined();
    expect(client._botOptions.liquidImmune).toBeUndefined();
    expect(client._botOptions).toMatchObject({ name: "Siege_Bot", difficulty: "hard" });
    vi.restoreAllMocks();
  });
});
