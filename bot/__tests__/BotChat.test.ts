/**
 * Bot chat: lines for humans only, paced, typed, and by personality.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { BotChat, type ChatView, personalityOf, resetBotChatPacing } from "../chat/BotChat";
import { BOT_CHAT_LINES } from "../chat/BotChatLines";

const names = new Map([
  ["h", "Tarmo"],
  ["b", "Ramen"],
]);

function view(over: Partial<ChatView> = {}): ChatView {
  return { phase: 2, names, mood: "calm", killStreak: 0, deathStreak: 0, events: [], ...over };
}

function clock() {
  const value = { now: 100_000 };
  return { value, now: () => value.now };
}

beforeEach(() => resetBotChatPacing());

describe("bot chat", () => {
  it("says something after killing a human, once it has typed it", () => {
    const time = clock();
    const chat = new BotChat("Miso", () => 0, time.now);
    chat.observe(view({ events: [{ kind: "kill", otherEntityId: "h", weaponId: "rlauncher", tick: 1 }] }));
    expect(chat.poll()).toBeNull(); // still typing
    time.value.now += 2600;
    const line = chat.poll();
    expect(BOT_CHAT_LINES.killedHuman.map((l) => l.replace("{name}", "Tarmo"))).toContain(line);
  });

  it("shows off a blade kill", () => {
    const time = clock();
    const chat = new BotChat("Miso", () => 0, time.now);
    chat.observe(view({ events: [{ kind: "kill", otherEntityId: "h", weaponId: "blade", tick: 1 }] }));
    time.value.now += 3000;
    expect(BOT_CHAT_LINES.bladeKill.map((l) => l.replace("{name}", "Tarmo"))).toContain(chat.poll());
  });

  it("does not talk about other bots, or in a match without humans", () => {
    const time = clock();
    const chat = new BotChat("Miso", () => 0, time.now);
    chat.observe(view({ events: [{ kind: "kill", otherEntityId: "b", weaponId: "rlauncher", tick: 1 }] }));
    time.value.now += 3000;
    expect(chat.poll()).toBeNull();

    const botsOnly = new BotChat("Shoyu", () => 0, time.now);
    botsOnly.observe(view({ phase: 1, names: new Map([["b", "Ramen"]]) }));
    botsOnly.observe(view({ phase: 2, names: new Map([["b", "Ramen"]]) }));
    time.value.now += 3000;
    expect(botsOnly.poll()).toBeNull();
  });

  it("greets when the match goes live and says gg near the end", () => {
    const time = clock();
    const chat = new BotChat("Miso", () => 0, time.now);
    chat.observe(view({ phase: 1 }));
    chat.observe(view({ phase: 2, timeRemaining: 600 }));
    time.value.now += 3000;
    expect(BOT_CHAT_LINES.greet.map((l) => l.replace("{name}", "Tarmo"))).toContain(chat.poll());

    time.value.now += 600_000;
    chat.observe(view({ phase: 2, timeRemaining: 20 }));
    time.value.now += 3000;
    expect(BOT_CHAT_LINES.gg.map((l) => l.replace("{name}", "Tarmo"))).toContain(chat.poll());
  });

  it("keeps to one line per 20 s per bot and one per 5 s across bots", () => {
    const time = clock();
    const kill = { kind: "kill" as const, otherEntityId: "h", weaponId: "rlauncher", tick: 1 };
    const a = new BotChat("Miso", () => 0, time.now);
    const b = new BotChat("Shoyu", () => 0, time.now);
    a.observe(view({ events: [kill] }));
    b.observe(view({ events: [kill] }));
    time.value.now += 3000;
    expect(a.poll()).not.toBeNull();
    expect(b.poll()).toBeNull(); // the room just heard from a
    time.value.now += 5000;
    a.observe(view({ events: [kill] }));
    time.value.now += 3000;
    expect(a.poll()).toBeNull(); // a spoke 11 s ago
  });

  it("gives each name a steady personality", () => {
    expect(personalityOf("Miso")).toEqual(personalityOf("Miso"));
    expect(personalityOf("Miso")).not.toEqual(personalityOf("Wasabi"));
  });

  it("has lines that fit chat", () => {
    for (const lines of Object.values(BOT_CHAT_LINES)) {
      expect(lines.length).toBeGreaterThanOrEqual(12);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});
