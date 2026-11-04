import { describe, expect, it } from "vitest";
import { inviteTarget } from "../InvitePaste";

const origin = "https://eu.washoi.net";

describe("inviteTarget", () => {
  it("joins this lobby's rooms through the lobby page", () => {
    expect(inviteTarget("https://eu.washoi.net/?lobby=a0fdc4aa&invite=tok_1", origin)).toEqual({
      kind: "join",
      url: "https://eu.washoi.net/client?lobby=a0fdc4aa&invite=tok_1",
    });
    expect(inviteTarget("  https://eu.washoi.net/lobby/a0fdc4aa  ", origin)).toEqual({
      kind: "join",
      url: "https://eu.washoi.net/client?lobby=a0fdc4aa",
    });
  });
  it("names another region's host", () => {
    expect(inviteTarget("https://us.washoi.net/?lobby=x1", origin)).toEqual({
      kind: "elsewhere",
      host: "us.washoi.net",
    });
  });
  it("ignores everything else", () => {
    expect(inviteTarget("hello there", origin)).toBeNull();
    expect(inviteTarget("https://eu.washoi.net/devlog", origin)).toBeNull();
    expect(inviteTarget("javascript:alert(1)?lobby=x", origin)).toBeNull();
    expect(inviteTarget("https://eu.washoi.net/?lobby=<script>", origin)).toBeNull();
  });
});
