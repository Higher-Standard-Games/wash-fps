/**
 * ClientEntityKey codec contract (QA-5).
 *
 * The client entity-key format (`player_<id>`) had ~20 ad-hoc mint/parse sites;
 * a mismatch silently broke the post-game showcase. These lock the one codec
 * they now all route through.
 */
import { describe, expect, it } from "vitest";
import { clientKeyDisplayId, ensureClientKey, isClientKey, parseClientKey, toClientKey } from "../ClientEntityKey";

describe("ClientEntityKey", () => {
  it("round-trips id -> key -> id", () => {
    for (const n of [0, 1, 3, 47, 999]) {
      expect(parseClientKey(toClientKey(n))).toBe(n);
    }
  });

  it("toClientKey formats player_<id>", () => {
    expect(toClientKey(3)).toBe("player_3");
    expect(toClientKey("7")).toBe("player_7");
  });

  it("isClientKey detects the prefix", () => {
    expect(isClientKey("player_3")).toBe(true);
    expect(isClientKey("3")).toBe(false);
  });

  it("parseClientKey returns null for non-keys, empty, or malformed", () => {
    expect(parseClientKey("3")).toBeNull();
    expect(parseClientKey("player_")).toBeNull();
    expect(parseClientKey("player_abc")).toBeNull();
  });

  it("clientKeyDisplayId strips the prefix and leaves non-keys unchanged", () => {
    expect(clientKeyDisplayId("player_3")).toBe("3");
    expect(clientKeyDisplayId("bob")).toBe("bob");
  });

  it("ensureClientKey is idempotent", () => {
    expect(ensureClientKey("3")).toBe("player_3");
    expect(ensureClientKey("player_3")).toBe("player_3");
  });
});
