/**
 * SuspendedSessions: a dropped client's seat is kept for the grace period, and
 * handed back to whoever presents its token.
 */

import { describe, expect, it } from "vitest";
import { SuspendedSessions } from "../SuspendedSessions";

const client = (resumeToken: string, playerName = resumeToken) => ({ resumeToken, playerName });

describe("SuspendedSessions", () => {
  it("gives a seat back to its token, once", () => {
    const sessions = new SuspendedSessions(20000);
    const dropped = client("token-a");
    sessions.suspend(dropped, 1000);

    expect(sessions.take("token-a")).toBe(dropped);
    expect(sessions.take("token-a")).toBeUndefined();
    expect(sessions.size).toBe(0);
  });

  it("knows nothing of a token it never issued", () => {
    const sessions = new SuspendedSessions(20000);
    sessions.suspend(client("token-a"), 1000);

    expect(sessions.take("guessed")).toBeUndefined();
    expect(sessions.size).toBe(1);
  });

  it("expires a seat once the grace has passed, and keeps one still inside it", () => {
    const sessions = new SuspendedSessions(20000);
    const early = client("token-a");
    const late = client("token-b");
    sessions.suspend(early, 1000);
    sessions.suspend(late, 15000);

    expect(sessions.expired(20000)).toEqual([]);
    expect(sessions.expired(21000)).toEqual([early]);
    expect(sessions.take("token-a")).toBeUndefined();
    expect(sessions.take("token-b")).toBe(late);
  });

  it("counts held seats as still present", () => {
    const sessions = new SuspendedSessions(20000);
    const held = client("token-a", "Wraith");
    sessions.suspend(held, 1000);

    expect(sessions.clients()).toEqual([held]);

    sessions.clear();

    expect(sessions.clients()).toEqual([]);
  });
});
