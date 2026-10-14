// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FPSChat } from "../hud/widgets/Chat";

let chat: FPSChat;
const submit = (text: string) => {
  chat.openInput();
  const input = document.querySelector("input")!;
  input.value = text;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
};
beforeEach(() => {
  vi.useFakeTimers();
  chat = new FPSChat();
  chat.openInput();
});
afterEach(() => {
  chat.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("leaves composing Enter/Escape to the IME, then allows normal send and cancel", () => {
  const sent = vi.fn();
  chat.onSend(sent);
  const input = document.querySelector("input")!;
  input.value = "hello";
  for (const options of [
    { key: "Enter", isComposing: true },
    { key: "Escape", isComposing: true },
    { key: "Enter", keyCode: 229 },
  ]) {
    const event = new KeyboardEvent("keydown", { ...options, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(chat.isInputActive()).toBe(true);
    expect(sent).not.toHaveBeenCalled();
  }
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(sent).toHaveBeenCalledExactlyOnceWith("hello");
  expect(chat.isInputActive()).toBe(false);
  chat.openInput();
  input.value = "cancel";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(sent).toHaveBeenCalledTimes(1);
  expect(chat.isInputActive()).toBe(false);
});

it("bounds an open history and preserves scrollback when old rows are pruned", () => {
  const log = document.querySelector<HTMLElement>(".fps-chat-log")!;
  Object.defineProperties(log, {
    scrollHeight: { get: () => log.children.length * 20 },
    clientHeight: { value: 100 },
  });
  for (let i = 0; i < 100; i++) chat.addMessage("player", String(i));
  log.scrollTop = 400;
  chat.addMessage("player", "100");
  expect(log.children.length).toBe(100);
  expect(log.scrollTop).toBe(380);
  expect(log.firstElementChild?.textContent).toBe("player1");
  log.scrollTop = 1900;
  for (let i = 101; i < 150; i++) chat.addMessage("player", String(i));
  expect(log.children.length).toBe(100);
  expect(log.scrollTop).toBe(log.scrollHeight);
  expect(log.lastElementChild?.textContent).toBe("player149");
});

it("keeps mute/unmute local, matches names without case, and restores future messages", () => {
  const sent = vi.fn();
  chat.onSend(sent);
  chat.addMessage("Ada", "old message");
  submit("/mute ADA");
  chat.addMessage("[SPEC] Ada", "ignored spec", "spectator", "Ada");
  chat.addMessage("Ada", "[TEAM] ignored team", "udon");
  chat.addMessage("Bob", "visible");
  expect(document.querySelector(".fps-chat-log")?.textContent).not.toContain("old message");
  expect(document.querySelector(".fps-chat-log")?.textContent).not.toContain("ignored");
  expect(document.querySelector(".fps-chat-log")?.textContent).toContain("visible");
  expect(sent).not.toHaveBeenCalled();
  submit("/unmute ada");
  chat.addMessage("Ada", "back again");
  expect(document.querySelector(".fps-chat-log")?.textContent).toContain("back again");
  expect(sent).not.toHaveBeenCalled();
});

it("clears match mutes and reports missing arguments locally", () => {
  const sent = vi.fn();
  chat.onSend(sent);
  submit("/mute");
  expect(document.querySelector(".fps-chat-log")?.textContent).toContain("Usage: /mute");
  submit("/unmute");
  expect(document.querySelector(".fps-chat-log")?.textContent).toContain("Usage: /unmute");
  submit("/mute Ada");
  chat.clearMutes();
  chat.addMessage("Ada", "new match");
  expect(document.querySelector(".fps-chat-log")?.textContent).toContain("new match");
  expect(sent).not.toHaveBeenCalled();
});

it("distinguishes team input and /say_team from ordinary chat", () => {
  const sent = vi.fn();
  chat.onSend(sent);
  chat.closeInput();
  chat.openInput(true);
  expect(chat.isInputActive()).toBe(false);
  chat.setLocalTeam("udon");
  chat.openInput(true);
  expect(document.querySelector(".fps-chat-prompt")?.textContent).toBe("TEAM");
  const input = document.querySelector("input")!;
  input.value = "hold site";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(sent).toHaveBeenLastCalledWith("hold site", true);
  submit("/say_team rotate");
  expect(sent).toHaveBeenLastCalledWith("rotate", true);
  submit("gg");
  expect(sent).toHaveBeenLastCalledWith("gg");
});
