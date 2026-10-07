// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import type { HUDState } from "../HUDState";
import { FPSPhaseMessage } from "../hud/widgets/PhaseMessage";
import { FPSReadyBar } from "../hud/widgets/ReadyBar";
import { MatchStateManager } from "../MatchStateManager";

/**
 * The HUD polls every widget 20 times a second. A widget whose output has not changed must
 * leave its elements alone: rewriting `innerHTML` throws the old elements away, which costs
 * parsing and layout each time, and restarts their CSS entrance animations, so the warmup
 * title (a 0.18 s stamp) was being re-stamped every 50 ms and never settled.
 */
const WARMUP = 0;
const ACTIVE = 2;

function enterMatchState(over: Record<string, unknown> = {}) {
  const manager = MatchStateManager.getInstance();
  manager.reset();
  manager.processEvent({
    type: "match_state",
    phase: WARMUP,
    timeRemaining: 0,
    readyCount: 0,
    totalPlayers: 2,
    gametypeName: "Duel",
    scoreLimit: 0,
    teamBased: false,
    standings: [],
    spectators: [],
    ...over,
  } as never);
  return manager;
}

const hud = (watcher = false) => ({ watcher }) as unknown as HUDState;

describe("warmup message", () => {
  let manager: MatchStateManager;
  beforeEach(() => {
    manager = enterMatchState();
  });

  it("is shown during warmup with the ready prompt", () => {
    const widget = new FPSPhaseMessage();
    widget.update(hud());
    expect(widget.getElement().textContent).toContain("Warmup");
    expect(widget.getElement().textContent).toContain("Duel");
    expect(widget.getElement().textContent).toContain("to ready up");
  });

  it("is left alone while nothing about it changes", () => {
    const widget = new FPSPhaseMessage();
    widget.update(hud());
    const title = widget.getElement().firstElementChild;
    expect(title).not.toBeNull();

    for (let tick = 0; tick < 10; tick++) widget.update(hud());

    // The very same elements, so nothing was rebuilt and no animation restarted.
    expect(widget.getElement().firstElementChild).toBe(title);
  });

  it("changes when the player readies up", () => {
    const widget = new FPSPhaseMessage();
    widget.update(hud());
    manager.setReady(true);
    widget.update(hud());
    expect(widget.getElement().textContent).toContain("Waiting for others");
    expect(widget.getElement().textContent).not.toContain("to ready up");
  });

  it("drops the prompt for a spectator", () => {
    const widget = new FPSPhaseMessage();
    widget.update(hud());
    widget.update(hud(true));
    expect(widget.getElement().textContent).not.toContain("ready up");
  });

  it("comes back if it was hidden while warmup is still on", () => {
    const widget = new FPSPhaseMessage();
    widget.update(hud());
    widget.getElement().classList.add("hidden");
    widget.update(hud());
    expect(widget.getElement().classList.contains("hidden")).toBe(false);
  });

  it("still announces the fight when the match goes live", () => {
    const widget = new FPSPhaseMessage();
    widget.update(hud());
    enterMatchState({ phase: ACTIVE });
    expect(widget.getElement().textContent).toContain("Fight!");
  });
});

describe("ready bar", () => {
  let manager: MatchStateManager;
  beforeEach(() => {
    manager = enterMatchState({ readyCount: 1 });
  });

  it("shows the count and the prompt to a player in warmup", () => {
    const bar = new FPSReadyBar();
    bar.update(hud());
    expect(bar.getElement().classList.contains("hidden")).toBe(false);
    expect(bar.getElement().textContent).toContain("when ready");
    expect(bar.getElement().querySelector(".fps-ready-count")?.textContent).toBe(manager.getReadyStatus());
  });

  it("is left alone while nothing about it changes", () => {
    const bar = new FPSReadyBar();
    bar.update(hud());
    const count = bar.getElement().firstElementChild;
    expect(count).not.toBeNull();

    for (let tick = 0; tick < 10; tick++) bar.update(hud());

    expect(bar.getElement().firstElementChild).toBe(count);
  });

  it("changes when the player readies up, and when the count changes", () => {
    const bar = new FPSReadyBar();
    bar.update(hud());
    manager.setReady(true);
    bar.update(hud());
    expect(bar.getElement().textContent).toContain("Ready!");
    expect(bar.getElement().classList.contains("fps-ready-bar--ready")).toBe(true);

    const before = bar.getElement().querySelector(".fps-ready-count")?.textContent;
    enterMatchState({ readyCount: 2 });
    MatchStateManager.getInstance().setReady(true);
    bar.update(hud());
    expect(bar.getElement().querySelector(".fps-ready-count")?.textContent).not.toBe(before);
  });

  it("shows a spectator the spectating plate, and a player their prompt again afterwards", () => {
    const bar = new FPSReadyBar();
    bar.update(hud(true));
    expect(bar.getElement().textContent).toContain("Spectating");
    expect(bar.getElement().classList.contains("fps-ready-bar--spectating")).toBe(true);

    bar.update(hud(false));
    expect(bar.getElement().textContent).toContain("when ready");
    expect(bar.getElement().classList.contains("fps-ready-bar--spectating")).toBe(false);
  });

  it("is left alone for a spectator too", () => {
    const bar = new FPSReadyBar();
    bar.update(hud(true));
    const plate = bar.getElement().firstElementChild;
    for (let tick = 0; tick < 10; tick++) bar.update(hud(true));
    expect(bar.getElement().firstElementChild).toBe(plate);
  });

  it("reappears if something hid it while warmup is still on", () => {
    const bar = new FPSReadyBar();
    bar.update(hud());
    bar.hide();
    bar.update(hud());
    expect(bar.getElement().classList.contains("hidden")).toBe(false);
  });

  it("hides outside warmup, and returns when warmup does", () => {
    const bar = new FPSReadyBar();
    enterMatchState({ phase: ACTIVE });
    bar.update(hud());
    expect(bar.getElement().classList.contains("hidden")).toBe(true);

    enterMatchState({ phase: WARMUP, readyCount: 1 });
    bar.update(hud());
    expect(bar.getElement().classList.contains("hidden")).toBe(false);
    expect(bar.getElement().textContent).toContain("when ready");
  });
});
