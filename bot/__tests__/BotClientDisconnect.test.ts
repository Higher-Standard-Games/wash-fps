import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { BotClient } from "../BotClient";

const sockets = vi.hoisted(() => [] as EventEmitter[]);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    WebSocket: class extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      send = vi.fn();
      constructor() {
        super();
        sockets.push(this);
      }
      close() {
        this.readyState = 3;
        this.emit("close", 1000, Buffer.alloc(0));
      }
    },
  };
});

let bot: BotClient | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  sockets.length = 0;
});
afterEach(async () => {
  await bot?.disconnect();
  await bot?.dispose();
  bot = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function acceptConnection(socket: EventEmitter) {
  socket.emit("open");
  const accepted = MessageCodec.encodeJoinAccept("client", "player", "entity");
  socket.emit("message", accepted);
  socket.emit("message", accepted);
}

async function playingBot() {
  bot = new BotClient({ name: "Cleanup", difficulty: "easy", chat: false });
  const connected = bot.connect("ws://bot-lifecycle.test");
  const socket = sockets[sockets.length - 1];
  acceptConnection(socket);
  await connected;
  // Start the real input timer independently of snapshot/AI processing.
  const start = Reflect.get(bot, "_startInputLoop") as () => void;
  start.call(bot);
  expect(vi.getTimerCount()).toBe(1);
  return { bot, socket };
}

it.each(["close", "error"])("releases the input timer on an unexpected socket %s", async (event) => {
  const { bot, socket } = await playingBot();
  if (event === "close") socket.emit("close", 1006, Buffer.alloc(0));
  else socket.emit("error", new Error("Connection lost"));
  expect(bot.state).toBe("disconnected");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the timer on an active connection and releases it on explicit disconnect", async () => {
  const { bot } = await playingBot();
  vi.advanceTimersByTime(32);
  expect(vi.getTimerCount()).toBe(1);
  await bot.disconnect();
  expect(vi.getTimerCount()).toBe(0);
});

async function expectFreshClientRequired(client: BotClient) {
  const count = sockets.length;
  const attempt = client.connect("ws://bot-lifecycle.test");
  const rejected = expect(attempt).rejects.toThrow(/fresh client/i);
  // Settle any incorrectly opened connection so a regression fails promptly.
  if (sockets.length > count) acceptConnection(sockets[count]);
  await rejected;
  expect(sockets).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
}

it.each(["disconnect", "close", "error"])("requires a fresh client after %s", async (event) => {
  const { bot, socket } = await playingBot();
  if (event === "disconnect") await bot.disconnect();
  else if (event === "close") socket.emit("close", 1006, Buffer.alloc(0));
  else socket.emit("error", new Error("Connection lost"));
  await expectFreshClientRequired(bot);
});

it("requires a fresh client after a failed connection attempt", async () => {
  bot = new BotClient({ name: "Failed", difficulty: "easy", chat: false });
  const failed = expect(bot.connect("ws://bot-lifecycle.test")).rejects.toThrow("Setup failed");
  sockets[0].emit("error", new Error("Setup failed"));
  await failed;
  await expectFreshClientRequired(bot);
});

it("rejects connection after disposal without opening a socket", async () => {
  bot = new BotClient({ name: "Disposed", difficulty: "easy", chat: false });
  await bot.dispose();
  await expectFreshClientRequired(bot);
});

it("retires an unused client when explicitly disconnected", async () => {
  bot = new BotClient({ name: "Retired", difficulty: "easy", chat: false });
  await bot.disconnect();
  await expectFreshClientRequired(bot);
});

it("allows a fresh client to replace a disposed client", async () => {
  const first = await playingBot();
  await first.bot.dispose();
  const next = await playingBot();
  expect(next.bot).not.toBe(first.bot);
  expect(next.bot.state).toBe("playing");
  expect(sockets).toHaveLength(2);
});

it("preserves rejection of a concurrent connection attempt", async () => {
  bot = new BotClient({ name: "Connecting", difficulty: "easy", chat: false });
  const connected = bot.connect("ws://bot-lifecycle.test");
  await expect(bot.connect("ws://bot-lifecycle.test")).rejects.toThrow("Already connected");
  expect(sockets).toHaveLength(1);
  acceptConnection(sockets[0]);
  await connected;
});
