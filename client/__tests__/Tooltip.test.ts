// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installTooltips, takeTitle } from "../Tooltip";

describe("Tooltip", () => {
  beforeAll(() => installTooltips());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("moves a title to data-tip and aria-description", () => {
    const button = document.createElement("button");
    button.title = "Open credits";
    expect(takeTitle(button)).toBe("Open credits");
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.dataset.tip).toBe("Open credits");
    expect(button.getAttribute("aria-description")).toBe("Open credits");
  });

  it("picks up a title set again later", () => {
    const button = document.createElement("button");
    button.title = "Old";
    takeTitle(button);
    button.title = "New";
    expect(takeTitle(button)).toBe("New");
  });

  it("shows a styled tip on hover after a short delay and hides it on press", () => {
    vi.useFakeTimers();
    const button = document.createElement("button");
    button.title = "Copy invite link";
    document.body.append(button);
    button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(document.querySelector(".fps-tip")).toBeNull();
    vi.advanceTimersByTime(500);
    expect(document.querySelector(".fps-tip")?.textContent).toBe("Copy invite link");
    expect(button.hasAttribute("title")).toBe(false);
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".fps-tip")).toBeNull();
  });
});
