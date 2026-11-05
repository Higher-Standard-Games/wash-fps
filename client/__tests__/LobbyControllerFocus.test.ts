// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { LobbyPanel } from "../LobbyPanel";

type FocusPanel = { controllerInitialFocus(): HTMLElement | null };
function panel(room?: HTMLElement): { panel: FocusPanel; rail: HTMLElement } {
  const rail = document.createElement("aside");
  rail.innerHTML = '<nav class="lobby__rail-nav"><button disabled>Quick play</button><button>Play</button></nav>';
  document.body.append(rail);
  if (room) document.body.append(room);
  return {
    panel: Object.assign(Object.create(LobbyPanel.prototype), {
      railEl: rail,
      currentTabId: "matchmaking",
      matchLobbyView: room ? { root: room } : null,
    }),
    rail,
  };
}
afterEach(() => document.body.replaceChildren());
describe("lobby controller entry focus", () => {
  it("starts on an enabled main-menu key", () => {
    const { panel: view, rail } = panel();
    expect(view.controllerInitialFocus()?.textContent).toBe("Play");
    (rail.querySelector("button") as HTMLButtonElement).disabled = false;
    expect(view.controllerInitialFocus()?.textContent).toBe("Quick play");
  });
  it("prefers map voting on entering a room and Ready after voting", () => {
    const room = document.createElement("section");
    room.innerHTML =
      '<button data-map="dm2" aria-pressed="false">Map</button><button class="raised-key--ready">Ready</button>';
    const { panel: view } = panel(room);
    expect(view.controllerInitialFocus()?.textContent).toBe("Map");
    room.querySelector("button")?.setAttribute("aria-pressed", "true");
    expect(view.controllerInitialFocus()?.textContent).toBe("Ready");
    (room.querySelector(".raised-key--ready") as HTMLButtonElement).disabled = true;
    expect(view.controllerInitialFocus()?.textContent).toBe("Play");
  });
});
