// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import type { HUDState, KillFeedEntry } from "../HUDState";
import { FPSDeathScreen } from "../hud/widgets/DeathScreen";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";

/** A demo's HUD: the camera is always behind the recorded player, and nobody watching is in the match. */
function demo(over: Partial<HUDState>): HUDState {
  return { localDead: false, dead: false, spectating: "player_2", playback: true, killFeed: [], ...over } as HUDState;
}

const visible = (screen: FPSDeathScreen) => screen.getElement().style.display !== "none";

describe("death screen in a demo", () => {
  beforeEach(() => {
    MatchStateManager.destroy();
    MatchStateManager.getInstance().processEvent({
      type: "match_state",
      phase: MatchPhase.Active,
      round: 0,
      gametypeName: "Deathmatch",
    });
  });

  it("shows the recorded player's death, names their killer, counts down, and goes when they respawn", () => {
    const screen = new FPSDeathScreen();
    screen.update(demo({}));
    expect(visible(screen)).toBe(false);

    const death = {
      victimId: "e2",
      killerId: "e5",
      victimName: "Recorded",
      killerName: "Ramen",
      weaponId: "rail",
      byLocal: false,
      ofLocal: false,
      byViewed: false,
      ofViewed: true,
      timestamp: Date.now(),
      seq: 1,
    } as unknown as KillFeedEntry;
    screen.update(demo({ dead: true, killFeed: [death] }));
    expect(visible(screen)).toBe(true);
    const text = screen.getElement().textContent ?? "";
    expect(text).toContain("YOU GOT FRAGGED");
    expect(text).toContain("Ramen");
    expect(text).toContain("Respawn in");

    screen.update(demo({ dead: false }));
    expect(visible(screen)).toBe(false);
  });
});
