import { describe, expect, it } from "vitest";
import { getPlayerTeamSlot } from "../PlayerModelVisualSettings";
import { __testing } from "../TeamColorBridge";

const { toCssColor } = __testing;

/**
 * Team colour is ALLEGIANCE, not team identity.
 *
 * Your own side is pink and anyone you may shoot is cyan, so the question a
 * colour answers mid-fight is "can I shoot this" rather than "which of two
 * names is this". It also makes the UI and the world agree by construction:
 * both read the same allegiance, so there is no mapping left to get backwards —
 * which is what had a teammate rendering cyan in the map while the scoreboard
 * drew their side magenta.
 */
describe("allegiance resolution", () => {
  it("calls your own side ally and the other side enemy", () => {
    expect(getPlayerTeamSlot("udon", "udon")).toBe("ally");
    expect(getPlayerTeamSlot("soba", "soba")).toBe("ally");
    expect(getPlayerTeamSlot("soba", "udon")).toBe("enemy");
    expect(getPlayerTeamSlot("udon", "soba")).toBe("enemy");
  });

  it("is symmetric — swapping sides swaps the answer, never both ally", () => {
    expect(getPlayerTeamSlot("udon", "soba")).toBe("enemy");
    expect(getPlayerTeamSlot("soba", "udon")).toBe("enemy");
  });

  it("folds the lobby and BSP names onto the same two sides", () => {
    // The lobby says alpha/bravo, the BSP says alpha/beta, the match says
    // udon/soba. A teammate must not turn into an enemy because a different
    // part of the stack named their side differently.
    expect(getPlayerTeamSlot("alpha", "soba")).toBe("ally");
    expect(getPlayerTeamSlot("beta", "soba")).toBe("ally");
    expect(getPlayerTeamSlot("bravo", "udon")).toBe("ally");
    expect(getPlayerTeamSlot("alpha", "udon")).toBe("enemy");
  });

  it("treats everyone as FFA when the viewer has no side", () => {
    // Spectating, or warmup before joining. Nobody is an ally, and the FFA
    // colour IS the enemy colour — in a free-for-all everyone is the enemy.
    expect(getPlayerTeamSlot("udon", null)).toBe("ffa");
    expect(getPlayerTeamSlot("udon", undefined)).toBe("ffa");
    expect(getPlayerTeamSlot("udon", "spectator")).toBe("ffa");
    expect(getPlayerTeamSlot("spectator", "udon")).toBe("ffa");
  });
});

describe("HDR tint to CSS colour", () => {
  it("keeps the hue of a colour that runs past 1.0", () => {
    // The shipped ally tint. Clamping each channel to a byte would give
    // #FF33FF — visibly pinker and brighter than chosen. Normalising to the
    // brightest channel keeps the ratio between them.
    expect(toCssColor(1.55, 0.2, 1.35)).toBe("#ff21de");
  });

  it("brightens a dim tint instead of rendering a near-black panel", () => {
    // A player who dims their world tint must not get an unreadable scoreboard.
    expect(toCssColor(0.155, 0.02, 0.135)).toBe("#ff21de");
  });

  it("survives a black or malformed tint rather than dividing by zero", () => {
    expect(toCssColor(0, 0, 0)).toBe("#ffffff");
    expect(toCssColor(Number.NaN, 0, 0)).toBe("#ffffff");
  });
});
