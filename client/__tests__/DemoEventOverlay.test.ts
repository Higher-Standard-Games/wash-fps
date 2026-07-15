// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { DemoEventOverlay } from "../DemoEventOverlay";
import { DemoEventTimeline } from "../DemoEventTimeline";

describe("DemoEventOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders, hides, shows, and destroys demo-time entries", () => {
    const timeline = new DemoEventTimeline();
    timeline.setClock(0, 60, 0);
    timeline.finishPresentationFrame();
    const overlay = new DemoEventOverlay(timeline);

    overlay.add("chat", "Alice: hello", 1000);
    const root = document.querySelector<HTMLElement>(".demo-event-overlay");
    expect(root?.textContent).toContain("Alice: hello");

    overlay.hide();
    expect(root?.style.display).toBe("none");
    overlay.show();
    expect(root?.style.display).toBe("");

    timeline.setClock(60, 60, 0);
    overlay.render();
    expect(root?.textContent).not.toContain("Alice: hello");
    overlay.destroy();
    expect(document.querySelector(".demo-event-overlay")).toBeNull();
  });

  it("does not render an event from a discontinuity landing frame", () => {
    const timeline = new DemoEventTimeline();
    timeline.setClock(500, 60, 3);
    const overlay = new DemoEventOverlay(timeline);
    expect(overlay.add("award", "FIRST BLOOD", 3000)).toBe(false);
    expect(document.querySelector(".demo-event-overlay")?.textContent).not.toContain("FIRST BLOOD");
    overlay.destroy();
  });
});
