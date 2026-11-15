import { campaignMatch } from "../../campaign/CampaignSession";
import { campaignStory } from "../../campaign/CampaignStory";
import { MatchStateManager } from "../../MatchStateManager";
import type { FPSHudWidget, HUDState } from "../HudWidget";

/**
 * FPSCampaignBriefing - what to do in a campaign mission, on a yellow plate in
 * the upper left while the opening countdown holds everyone still (and a
 * round mode's first freeze after it). It goes when the countdown ends, and
 * never shows in a match that is not a campaign one.
 */
export class FPSCampaignBriefing implements FPSHudWidget {
  private element: HTMLElement;
  private goal: HTMLElement;
  private points: HTMLUListElement;
  /** The mission whose briefing is filled in; null while none is. */
  private missionId: string | null = null;
  private shown = false;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "fps-campaign-briefing";
    this.goal = document.createElement("div");
    this.goal.className = "fps-campaign-briefing__goal";
    this.points = document.createElement("ul");
    this.points.className = "fps-campaign-briefing__points";
    this.element.append(this.goal, this.points);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public update(_state: HUDState): void {
    const match = MatchStateManager.getInstance();
    // The opening countdown only: a round mode counts down again before every later round
    const missionId = match.isCountdown() && match.round <= 1 ? (campaignMatch()?.missionId ?? null) : null;
    const briefing = missionId ? campaignStory(missionId)?.briefing : undefined;
    if (briefing && missionId !== this.missionId) {
      this.missionId = missionId;
      this.goal.textContent = briefing.goal;
      this.points.replaceChildren(
        ...briefing.points.map((point) => {
          const item = document.createElement("li");
          item.textContent = point;
          return item;
        }),
      );
    }
    const show = !!briefing;
    if (show !== this.shown) {
      this.shown = show;
      this.element.classList.toggle("fps-campaign-briefing--shown", show);
    }
  }

  public show(): void {
    this.element.style.display = "";
  }
  public hide(): void {
    this.element.style.display = "none";
  }

  public destroy(): void {
    this.element.remove();
  }
}
