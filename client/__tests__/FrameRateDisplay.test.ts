// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShowFpsCommand from "../../../../engine/console/commands/ShowFpsCommand";
import { Cvar } from "../../../../engine/core/Cvar";
import { FrameRateDisplay } from "../hud/FrameRateDisplay";

let display: FrameRateDisplay;
const command = new ShowFpsCommand();

beforeEach(() => {
  vi.useFakeTimers();
  Cvar.reset("show_fps");
});

afterEach(() => {
  display?.destroy();
  vi.useRealTimers();
});

describe("frame-rate display", () => {
  it("starts enabled, follows console changes and retains the off preference on recreation", async () => {
    display = new FrameRateDisplay(() => 144.3);
    expect(document.querySelector(".fps-frame-rate__value")?.textContent).toBe("144");
    expect((document.getElementById("fps-display") as HTMLElement).hidden).toBe(false);
    await command.execute(["off"]);
    vi.advanceTimersByTime(250);
    expect((document.getElementById("fps-display") as HTMLElement).hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem("engine_cvars")!).show_fps).toBe(0);
    display.destroy();
    display = new FrameRateDisplay(() => 60);
    expect((document.getElementById("fps-display") as HTMLElement).hidden).toBe(true);
    await command.execute(["on"]);
    vi.advanceTimersByTime(250);
    expect((document.getElementById("fps-display") as HTMLElement).hidden).toBe(false);
    expect(document.querySelectorAll("#fps-display")).toHaveLength(1);
  });

  it("skips unchanged DOM writes and stops sampling when hidden or destroyed", async () => {
    const getFps = vi.fn(() => 60);
    display = new FrameRateDisplay(getFps);
    const number = document.querySelector(".fps-frame-rate__value")!;
    const node = number.firstChild;
    vi.advanceTimersByTime(1000);
    expect(number.firstChild).toBe(node);
    await command.execute(["0"]);
    getFps.mockClear();
    vi.advanceTimersByTime(1000);
    expect(getFps).not.toHaveBeenCalled();
    display.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(document.getElementById("fps-display")).toBeNull();
  });
});
