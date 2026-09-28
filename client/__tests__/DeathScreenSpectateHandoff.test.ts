// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import type { HUDState, KillFeedEntry } from "../HUDState";
import { FPSDeathScreen, obituary } from "../hud/widgets/DeathScreen";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";

/**
 * The death panel's whole life in a round mode, in order.
 *
 * You go down, the panel says what happened while the camera holds on your
 * body, and then the camera moves to a living teammate and the panel gets out
 * of the way. What it must NOT do is come back — handing the screen over is not
 * being alive again.
 */
function hud(over: Partial<HUDState>): HUDState {
  const base = { localDead: false, spectating: "", killFeed: [], ...over };
  // `dead` describes whoever the camera is behind, so it mirrors ours whenever
  // we are not watching someone else. Modelled here rather than written out at
  // each call site because getting it wrong is what makes the test pass against
  // the bug: the panel reappears precisely BECAUSE the subject reverts to us.
  const dead = "dead" in over ? over.dead : base.spectating === "" && base.localDead;
  return { ...base, dead } as HUDState;
}

function visible(screen: FPSDeathScreen): boolean {
  return screen.getElement().style.display !== "none";
}

describe("death screen through the spectate handoff", () => {
  beforeEach(() => {
    MatchStateManager.destroy();
    MatchStateManager.getInstance().processEvent({
      type: "match_state",
      phase: MatchPhase.Active,
      round: 3,
      gametypeName: "Search & Destroy",
    });
  });

  it("shows on death, hides at the handoff, and stays down", () => {
    const screen = new FPSDeathScreen();

    // 1. Alive.
    screen.update(hud({}));
    expect(visible(screen)).toBe(false);

    // 2. Fragged. The corpse camera is up and this says why.
    screen.update(hud({ localDead: true }));
    expect(visible(screen)).toBe(true);

    // 3. A couple of seconds later the camera moves to a teammate. Their fight
    //    owns the screen now.
    screen.update(hud({ localDead: true, spectating: "player_4" }));
    expect(visible(screen)).toBe(false);

    // 4. The round ends and the camera leaves them for the round-end focus.
    //    We are still dead — but we were fragged a minute ago, and announcing
    //    it again here is the bug this test exists for.
    screen.update(hud({ localDead: true }));
    expect(visible(screen)).toBe(false);
  });

  it("does not come back when the teammate we are watching dies", () => {
    const screen = new FPSDeathScreen();
    screen.update(hud({ localDead: true }));
    screen.update(hud({ localDead: true, spectating: "player_4" }));

    // The spectated player is down, so the SUBJECT's dead flag is true — but
    // that is their death, not a second one of ours.
    screen.update(hud({ localDead: true, spectating: "player_4", dead: true }));

    expect(visible(screen)).toBe(false);
  });

  it("arms again for the next round's death", () => {
    const screen = new FPSDeathScreen();
    screen.update(hud({ localDead: true }));
    screen.update(hud({ localDead: true, spectating: "player_4" }));

    // The freeze revives us.
    screen.update(hud({}));
    expect(visible(screen)).toBe(false);

    // Down again next round. This is a new death and gets its own panel.
    screen.update(hud({ localDead: true }));
    expect(visible(screen)).toBe(true);
  });

  it("still hides on a plain respawn, with no spectating in between", () => {
    const screen = new FPSDeathScreen();

    screen.update(hud({ localDead: true }));
    expect(visible(screen)).toBe(true);

    screen.update(hud({}));
    expect(visible(screen)).toBe(false);
  });

  it("names the killer from the kill feed, by name rather than entity id", () => {
    const screen = new FPSDeathScreen();

    screen.update(hud({ localDead: true, killFeed: [death({ killerName: "Udon Bot", weaponId: "explosion" })] }));

    const text = screen.getElement().textContent ?? "";
    expect(text).toContain("Udon Bot");
    expect(text).toContain("Blown up by");
    expect(text).not.toContain("player_7");
  });

  it("names a death whose event lands after the dead flag", () => {
    const screen = new FPSDeathScreen();
    screen.update(hud({ localDead: true }));
    expect(screen.getElement().querySelector(".fps-death-card--named")).toBeNull();

    screen.update(hud({ localDead: true, killFeed: [death({ killerName: "Soba Bot" })] }));
    expect(screen.getElement().textContent).toContain("Soba Bot");
  });

  it("does not name someone else's death as ours", () => {
    const screen = new FPSDeathScreen();
    screen.update(hud({ localDead: true, killFeed: [death({ killerName: "Soba Bot", ofLocal: false })] }));
    expect(screen.getElement().querySelector(".fps-death-card--named")).toBeNull();
  });
});

function death(over: Partial<KillFeedEntry>): KillFeedEntry {
  return {
    victimId: "player_2",
    killerId: "player_7",
    victimName: "Me",
    killerName: "",
    weaponId: "bullet",
    byLocal: false,
    ofLocal: true,
    seq: 1,
    timestamp: performance.now(),
    ...over,
  };
}

describe("obituary", () => {
  it("says how, from the damage type, and who", () => {
    expect(obituary(death({ killerName: "Rex", weaponId: "rail" }))).toEqual({ how: "Railed by", who: "Rex" });
    expect(obituary(death({ killerName: "Rex", weaponId: "unknown" }))).toEqual({ how: "Fragged by", who: "Rex" });
  });

  it("blames nobody for a death nobody else caused", () => {
    expect(obituary(death({ killerId: "player_2", killerName: "Me", weaponId: "explosion" })).who).toBe(
      "Your own blast",
    );
    expect(obituary(death({ killerId: "", killerName: "", weaponId: "fall" }))).toEqual({
      how: "No one to blame",
      who: "The fall",
    });
  });
});
