/**
 * Trained models have to reach a bot that a player actually added.
 *
 * A bot asked for over the control socket takes its options from the message,
 * and the lobby sends only a difficulty — so without a default on the server,
 * every bot added from a room ran the plain state machine whatever had been
 * trained. TF-2 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { describe, expect, it, vi } from "vitest";
import { BotServer } from "../BotServer";

const captured: Array<Record<string, unknown>> = [];

vi.mock("../BotClient", () => ({
  BotClient: class {
    id = `bot_${captured.length}`;
    name = "Test";
    on() {}
    async connect() {}
    disconnect() {}
    constructor(options: Record<string, unknown>) {
      captured.push(options);
    }
  },
}));

vi.mock("../BotLobbyClient", () => ({
  BotLobbyClient: class {
    name = "Test";
    onGameBotCreated: unknown;
    async connect() {}
    disconnect() {}
    constructor(options: Record<string, unknown>) {
      captured.push(options);
    }
  },
}));

describe("a bot the server spawns", () => {
  it("inherits the server's model directory", async () => {
    captured.length = 0;
    const server = new BotServer(0, { modelDir: "./models/trained" });
    await server.addBot("ws://localhost:7777");
    expect(captured[0]).toMatchObject({ modelDir: "./models/trained" });
  });

  it("lets a request name its own directory instead", async () => {
    captured.length = 0;
    const server = new BotServer(0, { modelDir: "./models/trained" });
    await server.addBot("ws://localhost:7777", { modelDir: "./models/experiment" });
    expect(captured[0]).toMatchObject({ modelDir: "./models/experiment" });
  });

  it("carries the directory into a lobby bot too", async () => {
    captured.length = 0;
    const server = new BotServer(0, { modelDir: "./models/trained" });
    await server.addLobbyBot("ws://localhost:9000", "duel");
    expect(captured[0]).toMatchObject({ modelDir: "./models/trained" });
  });

  it("stays undefined when the server was given none", async () => {
    captured.length = 0;
    const server = new BotServer(0);
    await server.addBot("ws://localhost:7777");
    expect(captured[0].modelDir).toBeUndefined();
    expect(server.modelDir).toBeUndefined();
  });
});
