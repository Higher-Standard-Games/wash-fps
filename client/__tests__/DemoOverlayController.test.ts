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

  it("shows and hides the playback controls and replay chat together", () => {
    const controller = new DemoOverlayController();
    const controls = new OverlaySpy();
    const chat = new OverlaySpy();
    controller.setNormalHud(controls);
    controller.setChat(chat);
    expect([controls.visible, chat.visible]).toEqual([true, true]);
    controller.setVisible(false);
    expect([controls.visible, chat.visible]).toEqual([false, false]);
    controller.setVisible(true);
    expect([controls.visible, chat.visible]).toEqual([true, true]);
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
