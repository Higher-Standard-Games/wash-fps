// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { restartFlash } from "../hud/restartFlash";

const GROUP = ["hit", "heal"] as const;
const NAMES = ["flash"] as const;

function withAnimations(el: HTMLElement, animations: object[]) {
  (el as unknown as { getAnimations: () => object[] }).getAnimations = () => animations;
}

describe("restartFlash", () => {
  it("rewinds a running flash instead of forcing a layout", () => {
    const el = document.createElement("div");
    const running = { animationName: "flash", currentTime: 120 as number | null, play: vi.fn() };
    const other = { animationName: "crit-pulse", currentTime: 300 as number | null, play: vi.fn() };
    withAnimations(el, [running, other]);
    const layout = vi.spyOn(el, "offsetWidth", "get");
    el.classList.add("hit");

    restartFlash(el, "hit", GROUP, NAMES);

    expect(running.currentTime).toBe(0);
    expect(running.play).toHaveBeenCalled();
    expect(other.currentTime).toBe(300); // unrelated animations are left alone
    expect(layout).not.toHaveBeenCalled();
    expect(el.classList.contains("hit")).toBe(true);
  });

  it("starts a new flash by adding the class, swapping out the rest of its group", () => {
    const el = document.createElement("div");
    withAnimations(el, []);
    const layout = vi.spyOn(el, "offsetWidth", "get");
    el.classList.add("heal");
    restartFlash(el, "hit", GROUP, NAMES);
    expect([...el.classList]).toEqual(["hit"]);
    expect(layout).not.toHaveBeenCalled();
  });

  it("drops the class when its flash ends, so the next one is a plain add", () => {
    const el = document.createElement("div");
    withAnimations(el, []);
    restartFlash(el, "hit", GROUP, NAMES);
    const end = new Event("animationend") as Event & { animationName: string };
    end.animationName = "flash";
    el.dispatchEvent(end);
    expect(el.classList.length).toBe(0);
  });

  it("falls back to the reflow restart when a stale class has nothing to rewind", () => {
    const el = document.createElement("div");
    withAnimations(el, []);
    el.classList.add("hit");
    const layout = vi.spyOn(el, "offsetWidth", "get");
    restartFlash(el, "hit", GROUP, NAMES);
    expect(layout).toHaveBeenCalledOnce();
  });
});
