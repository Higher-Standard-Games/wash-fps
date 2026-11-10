import type { PlayerId } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { MatchPause, TIMEIN_COUNT_MS, TIMEOUT_MS } from "../MatchPause";

const alice = 1 as PlayerId;
const bob = 2 as PlayerId;

describe("match pause", () => {
  it("gives each player one timeout, and counts back in when someone calls time in", () => {
    const pause = new MatchPause();
    expect(pause.callTimeout(alice, "Alice", 0)).toBeNull();
    expect(pause.notice(1000)).toEqual({
      state: "timeout",
      msLeft: TIMEOUT_MS - 1000,
      caller: "Alice",
      forDrop: false,
    });
    expect(pause.callTimeout(bob, "Bob", 1000)).toBe("paused");
    expect(pause.callTimein(5000)).toBe(true);
    expect(pause.callTimein(5000)).toBe(false);
    expect(pause.update(5000 + TIMEIN_COUNT_MS - 1)).toBeNull();
    expect(pause.heldFor(5000 + TIMEIN_COUNT_MS)).toBe(5000 + TIMEIN_COUNT_MS);
    expect(pause.update(5000 + TIMEIN_COUNT_MS)).toBe("running");
    expect(pause.paused).toBe(false);
    expect(pause.callTimeout(alice, "Alice", 9000)).toBe("used");
    expect(pause.callTimeout(bob, "Bob", 9000)).toBeNull();
  });

  it("counts back in by itself when the timeout runs out", () => {
    const pause = new MatchPause();
    pause.callTimeout(alice, "Alice", 0);
    expect(pause.update(TIMEOUT_MS - 1)).toBeNull();
    expect(pause.update(TIMEOUT_MS)).toBe("timein");
    expect(pause.update(TIMEOUT_MS + TIMEIN_COUNT_MS)).toBe("running");
  });

  it("lets a timeout stop the count back in, holding from the first pause", () => {
    const pause = new MatchPause();
    pause.callTimeout(alice, "Alice", 0);
    pause.callTimein(1000);
    expect(pause.callTimeout(bob, "Bob", 2000)).toBeNull();
    expect(pause.notice(2000)).toMatchObject({ state: "timeout", caller: "Bob" });
    expect(pause.heldFor(4000)).toBe(4000);
  });

  it("calls one for a dropped player without spending anyone's", () => {
    const pause = new MatchPause();
    expect(pause.callForDrop("Alice", 0)).toBe(true);
    expect(pause.notice(0)).toMatchObject({ state: "timeout", caller: "Alice", forDrop: true });
    expect(pause.callForDrop("Bob", 0)).toBe(false);
    pause.callTimein(0);
    pause.update(TIMEIN_COUNT_MS);
    expect(pause.callTimeout(alice, "Alice", TIMEIN_COUNT_MS)).toBeNull();
  });

  it("gives everyone their timeout back for a new match", () => {
    const pause = new MatchPause();
    pause.callTimeout(alice, "Alice", 0);
    pause.reset();
    expect(pause.paused).toBe(false);
    expect(pause.callTimeout(alice, "Alice", 0)).toBeNull();
  });
});
