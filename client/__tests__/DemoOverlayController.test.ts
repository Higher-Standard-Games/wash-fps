// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { type DemoOverlay, DemoOverlayController } from "../DemoOverlayController";

class OverlaySpy implements DemoOverlay {
  visible = false;
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
}

describe("DemoOverlayController", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the active HUD and includes replay chat in the shared policy", () => {
    const controller = new DemoOverlayController();
    const normal = new OverlaySpy();
    const cinematic = new OverlaySpy();
    const chat = new OverlaySpy();
    controller.setNormalHud(normal);
    controller.setCinematicHud(cinematic);
    controller.setChat(chat);
    expect([normal.visible, cinematic.visible, chat.visible]).toEqual([true, false, true]);

    controller.setMode("cinematic");
    expect([normal.visible, cinematic.visible, chat.visible]).toEqual([false, true, true]);
    controller.setVisible(false);
    expect([normal.visible, cinematic.visible, chat.visible]).toEqual([false, false, false]);
    controller.setVisible(true);
    expect([normal.visible, cinematic.visible, chat.visible]).toEqual([false, true, true]);
  });

  it("handles H safely and removes its listener on reset", () => {
    const controller = new DemoOverlayController();
    controller.bindKeyboard(document);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyH" }));
    expect(controller.isVisible()).toBe(false);

    const input = document.body.appendChild(document.createElement("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyH" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyH", ctrlKey: true }));
    expect(controller.isVisible()).toBe(false);

    controller.reset();
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyH" }));
    expect(controller.isVisible()).toBe(true);
  });
});
