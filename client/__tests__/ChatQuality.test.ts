// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FPSChat } from "../hud/widgets/Chat";

let chat: FPSChat;
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
