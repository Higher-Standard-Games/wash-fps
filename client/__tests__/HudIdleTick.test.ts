// @vitest-environment jsdom
import { expect, it } from "vitest";
import { FPSHud } from "../FPSHud";
import { HUDState } from "../HUDState";
import { MatchPhase, MatchStateManager } from "../MatchStateManager";

// The HUD ticks 20 times a second. A tick where nothing changed must not touch
// the page: every write, even of the same value, can cost the browser a restyle.
it("leaves the page alone on ticks where nothing changed", async () => {
  (globalThis as { FontFace?: unknown }).FontFace = class {
    load() {
      return Promise.resolve(this);
    }
  };
  Object.defineProperty(document, "fonts", { configurable: true, value: { add() {} } });
  const hud = FPSHud.getInstance();
  await hud.init();
  const tick = () => (hud as unknown as { update(): void }).update();

  const state = HUDState.getInstance() as unknown as Record<string, unknown>;
  Object.assign(state, { localPlayerId: "me", health: 100, armor: 50, currentWeapon: "blade", weapons: ["blade"] });
  const match = MatchStateManager.getInstance() as unknown as Record<string, unknown>;
  const situations: Array<[string, () => void]> = [
    ["playing", () => Object.assign(match, { _phase: MatchPhase.Active, _timeRemaining: 300 })],
    ["warmup", () => Object.assign(match, { _phase: MatchPhase.Warmup, _timeRemaining: 0, _gametypeName: "DM" })],
    ["spectating", () => Object.assign(state, { watcher: true, spectating: "bot1" })],
    ["dead", () => Object.assign(state, { watcher: false, spectating: "", dead: true, localDead: true, health: 0 })],
  ];

  for (const [name, enter] of situations) {
    enter();
    tick();
    const writes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) writes.push(`${r.type} ${r.attributeName ?? ""} on ${(r.target as Element).className}`);
    });
    observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
    for (let i = 0; i < 5; i++) tick();
    await Promise.resolve();
    observer.disconnect();
    expect(writes, name).toEqual([]);
  }
  hud.destroy();
});
