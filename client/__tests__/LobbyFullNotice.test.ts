// @vitest-environment jsdom

/**
 * The full-lobby notice: it counts down to the next try, spread a little so
 * everyone turned away doesn't come back in the same second, and Try now
 * retries at once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { LobbyFullNotice, retryDelaySec } from "../LobbyFullNotice";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("retryDelaySec", () => {
  it("waits the lobby's time, give or take ten seconds", () => {
    expect(retryDelaySec(60, () => 0)).toBe(50);
    expect(retryDelaySec(60, () => 0.5)).toBe(60);
    expect(retryDelaySec(60, () => 1)).toBe(70);
  });

  it("waits a minute when the lobby names no time, and never less than five seconds", () => {
    expect(retryDelaySec(undefined, () => 0.5)).toBe(60);
    expect(retryDelaySec(2, () => 0)).toBe(5);
  });
});

describe("LobbyFullNotice", () => {
  const countdown = () => document.querySelector(".lobby-full__countdown")?.textContent;

  it("counts down and tries again when the time is up", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const retry = vi.fn();
    const notice = new LobbyFullNotice(retry);
    notice.wait(document.body, 3);

    expect(document.querySelector(".lobby-full__title")?.textContent).toBe("Servers are full");
    expect(countdown()).toBe("Retrying in 5 s…");
    vi.advanceTimersByTime(1000);
    expect(countdown()).toBe("Retrying in 4 s…");
    vi.advanceTimersByTime(4000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(countdown()).toBe("Connecting…");
    vi.advanceTimersByTime(10_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("tries at once from Try now, and starts a new countdown if still full", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const retry = vi.fn();
    const notice = new LobbyFullNotice(retry);
    notice.wait(document.body, 60);
    const key = document.querySelector<HTMLButtonElement>(".lobby-full button");
    key?.click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(key?.disabled).toBe(true);

    notice.wait(document.body, 60);
    expect(key?.disabled).toBe(false);
    expect(countdown()).toBe("Retrying in 60 s…");
    expect(document.querySelectorAll(".lobby-full")).toHaveLength(1);
  });

  it("goes away and stops counting when closed", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const notice = new LobbyFullNotice(retry);
    notice.wait(document.body, 60);
    notice.close();
    expect(notice.isOpen).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(retry).not.toHaveBeenCalled();
  });
});
