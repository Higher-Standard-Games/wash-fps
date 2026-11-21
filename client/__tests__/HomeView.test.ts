// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeView } from "../HomeView";

const views: HomeView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function makeView() {
  const actions = { quickPlay: vi.fn(), campaign: vi.fn(), playOnline: vi.fn() };
  const view = new HomeView(actions);
  views.push(view);
  const card = (kind: string) =>
    view.root.querySelector<HTMLButtonElement>(`.home__card--${kind}`) as HTMLButtonElement;
  return { actions, view, card };
}

describe("HomeView", () => {
  it("shows the three cards in order, each with its title and caption", () => {
    const { view } = makeView();
    const labels = [...view.root.querySelectorAll(".home__card")].map((c) => c.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Quick play: Free For All",
      "Campaign: Single player challenge",
      "Play online: Multiplayer lobbies",
    ]);
    expect(view.root.querySelectorAll(".home__mode")).toHaveLength(4);
  });

  it("runs each card's action on click", () => {
    const { actions, card } = makeView();
    card("quick").click();
    card("campaign").click();
    card("online").click();
    expect(actions.quickPlay).toHaveBeenCalledTimes(1);
    expect(actions.campaign).toHaveBeenCalledTimes(1);
    expect(actions.playOnline).toHaveBeenCalledTimes(1);
  });

  it("follows Quick play's availability and ignores a disabled card", () => {
    const { actions, view, card } = makeView();
    view.setQuickPlayEnabled(false);
    expect(card("quick").disabled).toBe(true);
    card("quick").dispatchEvent(new MouseEvent("click"));
    expect(actions.quickPlay).not.toHaveBeenCalled();
    view.setQuickPlayEnabled(true);
    card("quick").click();
    expect(actions.quickPlay).toHaveBeenCalledTimes(1);
  });

  it("moves Quick play's shots on, never repeating the one on screen, only while Home is shown", async () => {
    vi.useFakeTimers();
    const { view } = makeView();
    const shown = () => view.root.querySelector<HTMLImageElement>(".home__shot--on")?.getAttribute("src") ?? null;
    await vi.advanceTimersByTimeAsync(0);
    const first = shown();
    expect(first).toMatch(/\/images\/home\/quick-\d\d\.webp$/);

    // Off screen: the shot stays
    await vi.advanceTimersByTimeAsync(7000);
    expect(shown()).toBe(first);

    document.body.append(view.root);
    const seen = new Set([first]);
    let last = first;
    for (let turn = 0; turn < 12; turn++) {
      await vi.advanceTimersByTimeAsync(7000);
      expect(shown()).not.toBe(last);
      last = shown();
      seen.add(last);
    }
    expect(seen.size).toBeGreaterThan(3);
    expect(view.root.querySelectorAll(".home__shot--on")).toHaveLength(1);

    view.destroy();
    await vi.advanceTimersByTimeAsync(21000);
    expect(shown()).toBe(last);
  });
});
