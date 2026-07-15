// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { DemoViewerHUD } from "../DemoViewerHUD";

describe("DemoViewerHUD", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the collapse control reachable and restores player/stat rows", () => {
    const hud = new DemoViewerHUD();
    hud.setPlayerList([{ entityId: "player_1", name: "Alice", isTarget: true }]);
    hud.setSpectatorStats({ name: "Alice", health: 100, armor: 50, weapon: "rocket", ammo: "8 / 24" });

    const container = document.querySelector<HTMLElement>("#demo-viewer-hud");
    const collapse = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.title === "Minimize HUD",
    );
    const playerButton = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Alice",
    );
    const statName = Array.from(container?.querySelectorAll("span") ?? []).find((span) => span.textContent === "Alice");
    const playerList = playerButton?.parentElement;
    const stats = statName?.parentElement;

    collapse?.click();
    expect(collapse?.isConnected).toBe(true);
    expect(collapse?.title).toBe("Expand HUD");
    expect(playerList?.style.display).toBe("none");
    expect(stats?.style.display).toBe("none");

    collapse?.click();
    expect(collapse?.title).toBe("Minimize HUD");
    expect(playerList?.style.display).toBe("flex");
    expect(stats?.style.display).toBe("flex");

    hud.hide();
    expect(container?.style.display).toBe("none");
    hud.show();
    expect(container?.style.display).toBe("flex");
    hud.dispose();
    expect(document.querySelector("#demo-viewer-hud")).toBeNull();
  });
});
