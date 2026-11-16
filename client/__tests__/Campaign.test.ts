// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import type { CampaignMissionInfo } from "../../../../lobby/types";
import { ART_FADE_MS, CampaignCutscene, PANEL_MS, panelClip, panelView } from "../campaign/CampaignCutscene";
import { missionPlaylist } from "../campaign/CampaignMusic";
import {
  cacheCampaign,
  cachedCampaign,
  cacheMissionLooks,
  campaignMatch,
  missionLook,
  rememberCampaignMatch,
  requestCampaignRetry,
  takeCampaignRetry,
  takeCampaignReturn,
} from "../campaign/CampaignSession";
import { campaignStory } from "../campaign/CampaignStory";
import { CampaignView, missionStatus } from "../campaign/CampaignView";
import { FPSCampaignBriefing } from "../hud/widgets/CampaignBriefing";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";
import {
  forcedModelForName,
  forcePlayerModels,
  playerModelChoice,
  registerPlayerModelSelection,
} from "../PlayerModelSelection";
import {
  getPlayerModelVisualStyle,
  getPlayerModelVisualStyleKey,
  registerPlayerModelVisualCvars,
  setCampaignTeammates,
} from "../PlayerModelVisualSettings";

const mission = (id: string, number: number, difficulty = "easy"): CampaignMissionInfo => ({
  id,
  number,
  map: `map${number}`,
  mapTitle: `Map ${number}`,
  gametype: "duel",
  bots: [{ name: "Rival", difficulty, side: "enemy" }],
  models: { ally: "robot", enemy: "cartel" },
});
const MISSIONS = [mission("cartel-contract", 1), mission("street-riot", 2), mission("glitch-duel", 3, "medium")];
const state = (cleared: string[], unlockedThrough: number) => ({
  length: 8,
  missions: MISSIONS,
  clears: cleared.map((missionId) => ({ missionId, clearedAt: 1, bestTimeMs: 504_000, bestFrags: 32 })),
  unlockedThrough,
});

describe("campaign card", () => {
  it("fits a panel to the screen, centred", () => {
    const panel = { x: 100, y: 50, w: 400, h: 800 };
    const view = panelView(panel, 1600, 1000);
    expect(view.scale).toBeCloseTo((1000 * 0.84) / 800);
    expect(view.x + (panel.x + panel.w / 2) * view.scale).toBeCloseTo(800);
    expect(view.y + (panel.y + panel.h / 2) * view.scale).toBeCloseTo(500);
  });

  it("clips the image to the panel", () => {
    expect(panelClip({ x: 14, y: 14, w: 707, h: 836 }, { width: 1536, height: 864 })).toBe(
      "inset(14px 815px 14px 14px)",
    );
  });

  it("plays its own song only in the cartel, survival and boss missions", () => {
    expect(missionPlaylist("cartel-contract")).toBe("data/campaign_cartel.playlist.json");
    expect(missionPlaylist("bot-trap")).toBe("data/campaign_survival.playlist.json");
    expect(missionPlaylist("siege-breaker")).toBe("data/campaign_boss.playlist.json");
    expect(missionPlaylist("road-ends")).toBe("data/campaign_boss.playlist.json");
    for (const id of ["street-riot", "concrete-sabotage", "glitch-duel", "depot-heist"]) {
      expect(missionPlaylist(id)).toBeNull();
    }
  });

  it("briefs every mission: a goal and what decides it", () => {
    for (const id of [
      "cartel-contract",
      "street-riot",
      "concrete-sabotage",
      "glitch-duel",
      "bot-trap",
      "siege-breaker",
      "depot-heist",
      "road-ends",
    ]) {
      const briefing = campaignStory(id)!.briefing;
      expect(briefing.goal.length).toBeGreaterThan(0);
      expect(briefing.points.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("shows the briefing over a campaign match's opening countdown, and only then", () => {
    const widget = new FPSCampaignBriefing();
    const match = MatchStateManager.getInstance();
    const phase = (value: MatchPhase) =>
      match.processEvent({
        type: "match_state",
        phase: value,
        timeRemaining: 10,
        readyCount: 0,
        totalPlayers: 5,
        gametypeName: "Free For All",
        scoreLimit: 0,
        teamBased: false,
      } as never);
    const shown = () => widget.getElement().classList.contains("fps-campaign-briefing--shown");

    match.reset();
    phase(MatchPhase.Countdown);
    widget.update({} as never);
    // Not a campaign match: nothing to brief
    expect(shown()).toBe(false);

    rememberCampaignMatch({ missionId: "street-riot", models: { ally: "robot", enemy: "cartel" } });
    widget.update({} as never);
    expect(shown()).toBe(true);
    expect(widget.getElement().textContent).toContain("You must finish as top scorer!");

    phase(MatchPhase.Active);
    widget.update({} as never);
    expect(shown()).toBe(false);
    widget.destroy();
  });

  it("has a card with framed panels inside the image for every written mission", () => {
    for (const id of [
      "cartel-contract",
      "street-riot",
      "concrete-sabotage",
      "glitch-duel",
      "bot-trap",
      "siege-breaker",
    ]) {
      const card = campaignStory(id)!.card!;
      expect(card.panels.length).toBeGreaterThanOrEqual(2);
      for (const panel of card.panels) {
        expect(panel.x + panel.w).toBeLessThanOrEqual(card.width);
        expect(panel.y + panel.h).toBeLessThanOrEqual(card.height);
      }
    }
    expect(campaignStory("unknown")).toBeNull();
  });
});

describe("cutscene", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    HTMLImageElement.prototype.decode = () => Promise.resolve();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("moves through the panels on a timer or a key, then hands over", async () => {
    const done = vi.fn();
    const card = campaignStory("cartel-contract")!.card!;
    const cutscene = new CampaignCutscene({
      card,
      label: "Operation 01",
      title: "Cartel Contract",
      onPanelsDone: done,
    });
    const playing = cutscene.play();
    await vi.advanceTimersByTimeAsync(500);
    await playing;
    expect(cutscene.root.classList.contains("campaign-cut--art")).toBe(true);
    const clipped = () => (cutscene.root.querySelector(".campaign-cut__art--sharp") as HTMLElement).style.clipPath;
    expect(clipped()).toBe(panelClip(card.panels[0], card));
    expect(cutscene.root.querySelector(".campaign-cut__title")?.textContent).toBe("Cartel Contract");
    expect(cutscene.root.querySelector(".campaign-cut__count")?.textContent).toBe("1 / 2");
    // A panel holds for its full time once it has faded in, not counting the fade
    await vi.advanceTimersByTimeAsync(PANEL_MS);
    expect(clipped()).toBe(panelClip(card.panels[0], card));
    await vi.advanceTimersByTimeAsync(ART_FADE_MS + 10);
    expect(clipped()).toBe(panelClip(card.panels[1], card));
    expect(cutscene.root.querySelector(".campaign-cut__count")?.textContent).toBe("2 / 2");
    expect(done).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(done).toHaveBeenCalledOnce();
    expect(cutscene.root.classList.contains("campaign-cut--waiting")).toBe(true);
    cutscene.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cutscene.root.isConnected).toBe(false);
  });

  it("skips to the end on Escape and shows a failure with a way back", async () => {
    const done = vi.fn();
    const back = vi.fn();
    const cutscene = new CampaignCutscene({
      card: campaignStory("street-riot")!.card!,
      label: "Operation 02",
      title: "Street Riot",
      onPanelsDone: done,
    });
    const playing = cutscene.play();
    await vi.advanceTimersByTimeAsync(500);
    await playing;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(done).toHaveBeenCalledOnce();
    cutscene.fail("No bots", back);
    expect(cutscene.root.textContent).toContain("No bots");
    (cutscene.root.querySelector(".campaign-cut__back") as HTMLButtonElement).click();
    expect(back).toHaveBeenCalledOnce();
  });
});

describe("campaign page", () => {
  it("marks cleared, current and locked missions", () => {
    expect(missionStatus(1, null)).toBe("current");
    expect(missionStatus(2, null)).toBe("locked");
    const progress = state(["cartel-contract"], 2);
    expect([1, 2, 3, 4].map((n) => missionStatus(n, progress))).toEqual(["cleared", "current", "locked", "locked"]);
  });

  it("draws eight operations, starts only unlocked ones and only when it may", () => {
    const start = vi.fn();
    const view = new CampaignView({ start });
    view.setState(state(["cartel-contract"], 2));
    const cards = view.root.querySelectorAll(".campaign-card:not(.campaign-finale)");
    expect(cards).toHaveLength(8);
    expect(view.root.querySelectorAll(".campaign-card--locked:not(.campaign-finale)")).toHaveLength(6);
    // The finale stays classified until every operation is cleared
    const finale = view.root.querySelector<HTMLElement>(".campaign-finale");
    expect(finale?.classList.contains("campaign-card--locked")).toBe(true);
    expect(finale?.querySelector("img")).toBeNull();
    expect(finale?.dataset.from).toBe("locked");
    expect(view.progressHint()).toBe("1 / 8 cleared");
    // Cleared and next alike carry one bullet, the game mode's name
    expect([...view.root.querySelectorAll(".campaign-card__brief")].map((list) => list.textContent)).toEqual([
      "Duel",
      "Duel",
    ]);
    // The track into each node takes the colour of the operation before it
    expect([...cards].map((row) => (row as HTMLElement).dataset.from ?? "")).toEqual([
      "",
      "cleared",
      "current",
      "locked",
      "locked",
      "locked",
      "locked",
      "locked",
    ]);
    const keys = () => [...view.root.querySelectorAll<HTMLButtonElement>(".campaign-card__start")];
    expect(keys()).toHaveLength(2);
    expect(keys().every((key) => key.disabled)).toBe(true);
    view.setStartable(true);
    keys()[1].click();
    expect(start).toHaveBeenCalledWith(MISSIONS[1]);
  });
});

describe("campaign finale", () => {
  const ids = MISSIONS.map((m) => m.id);
  const finished = { ...state(ids, 3), length: 3 };
  afterEach(() => localStorage.clear());

  it("shows the finale card under the last operation once every one is cleared", () => {
    const view = new CampaignView({ start: vi.fn() });
    view.setState(finished);
    const finale = view.root.querySelector<HTMLElement>(".campaign-finale--complete");
    expect(finale?.querySelector(".campaign-finale__title")?.textContent).toBe("Campaign complete!");
    expect(finale?.querySelector("img")?.getAttribute("src")).toBe("/images/campaign/card9-thumb.webp");
    expect(finale?.dataset.from).toBe("cleared");
  });

  it("reads a card panel by panel when it is clicked, without starting anything", () => {
    const start = vi.fn();
    const view = new CampaignView({ start });
    view.setState(finished);
    document.body.append(view.root);
    view.root.querySelector<HTMLElement>(".campaign-card__art--readable")?.click();
    const cutscene = document.querySelector(".campaign-cut");
    expect(cutscene?.getAttribute("aria-label")).toBe("Operation 01: Cartel Contract");
    expect(start).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    cutscene?.remove();
    // The finale's card reads the same way
    view.root.querySelector<HTMLElement>(".campaign-finale__art")?.click();
    const finale = document.querySelector(".campaign-cut");
    expect(finale?.getAttribute("aria-label")).toBe("Finale: Campaign complete!");
    // Esc reads to the end, which closes a card read from the page and stops its key listener
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    finale?.remove();
    view.root.remove();
  });

  it("leaves a locked operation's card unreadable", () => {
    const view = new CampaignView({ start: vi.fn() });
    view.setState(state(["cartel-contract"], 2));
    const readable = view.root.querySelectorAll(".campaign-card__art--readable");
    // Two open operations have cards; the locked ones and the classified finale do not read
    expect(readable).toHaveLength(2);
  });
});

describe("campaign session", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Cvar.init();
    registerPlayerModelSelection();
  });
  afterEach(() => forcePlayerModels(null));

  it("keeps each mission's look for its demos, including a mission the lobby has since dropped", () => {
    cacheMissionLooks(MISSIONS);
    cacheMissionLooks([MISSIONS[1]]);
    expect(missionLook("cartel-contract")?.missionId).toBe("cartel-contract");
    expect(missionLook("street-riot")?.missionId).toBe("street-riot");
    expect(missionLook("unknown")).toBeNull();
  });

  it("keeps the account's progress for the next visit", () => {
    cacheCampaign("7", { type: "campaign:state", ...state(["cartel-contract"], 2) });
    expect(cachedCampaign("7")?.unlockedThrough).toBe(2);
    expect(cachedCampaign("8")).toBeNull();
  });

  it("carries the mission to the game and back to the lobby once", () => {
    rememberCampaignMatch({ missionId: "cartel-contract", models: { ally: "robot", enemy: "cartel" } });
    expect(campaignMatch()?.models.enemy).toBe("cartel");
    expect(takeCampaignReturn()?.missionId).toBe("cartel-contract");
    expect(takeCampaignReturn()).toBeNull();
  });

  it("carries a retry back to the lobby once", () => {
    expect(takeCampaignRetry()).toBeNull();
    requestCampaignRetry("bot-trap");
    expect(takeCampaignRetry()).toBe("bot-trap");
    expect(takeCampaignRetry()).toBeNull();
  });

  it("forces the mission's models over the settings, until cleared", () => {
    Cvar.set("cl_team_ally_model", "police");
    Cvar.set("cl_team_enemy_model", "female");
    forcePlayerModels({ ally: "robot", enemy: "cartel" });
    expect([playerModelChoice("ally"), playerModelChoice("enemy")]).toEqual(["robot", "cartel"]);
    forcePlayerModels({ ally: "robot", enemy: "dragon" });
    expect([playerModelChoice("ally"), playerModelChoice("enemy")]).toEqual(["robot", "female"]);
    forcePlayerModels(null);
    expect([playerModelChoice("ally"), playerModelChoice("enemy")]).toEqual(["police", "female"]);
  });

  it("gives named crew members their own model, and forgets them after the match", () => {
    forcePlayerModels({ ally: "robot", enemy: "police" }, { Ratchet: "cartel", Socket: "riotkitty", Odd: "dragon" });
    expect([forcedModelForName("Ratchet"), forcedModelForName("Socket")]).toEqual(["cartel", "riotkitty"]);
    expect(forcedModelForName("Odd")).toBeNull();
    expect(forcedModelForName("Kade")).toBeNull();
    expect(playerModelChoice("enemy")).toBe("police");
    forcePlayerModels(null);
    expect(forcedModelForName("Ratchet")).toBeNull();
  });

  it("draws teammates lime, tinted and outlined, whatever the settings, only in a campaign match", () => {
    registerPlayerModelVisualCvars();
    Cvar.set("cl_player_tint", 0);
    Cvar.set("cl_player_outline", 0);
    const plain = getPlayerModelVisualStyle("ally", 1);
    expect(plain.tintColor).toBeNull();
    expect(plain.outlineEnabled).toBe(false);
    const plainKey = getPlayerModelVisualStyleKey("ally");

    setCampaignTeammates(true);
    try {
      const green = getPlayerModelVisualStyle("ally", 1);
      expect(green.outlineEnabled).toBe(true);
      expect(green.tintColor?.g).toBeGreaterThan(green.tintColor?.r ?? 0);
      expect(green.outlineColor.g).toBeGreaterThan(green.outlineColor.r);
      expect(getPlayerModelVisualStyleKey("ally")).not.toBe(plainKey);
      // Enemies keep the player's settings
      expect(getPlayerModelVisualStyle("enemy", 1).outlineEnabled).toBe(false);
    } finally {
      setCampaignTeammates(false);
    }
    expect(getPlayerModelVisualStyleKey("ally")).toBe(plainKey);
  });
});
