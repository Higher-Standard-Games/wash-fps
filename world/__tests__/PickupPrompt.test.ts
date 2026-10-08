// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { hidePickupPrompt, showPickupPrompt } from "../PickupPrompt";

/**
 * A weapon spawn and a dropped weapon share one prompt. Walking off the dropped
 * weapon while still at the spawn took the spawn's prompt down with it, and the
 * spawn, already counting itself as shown, never asked again (W9).
 */
describe("pickup prompt shared by two systems", () => {
  const prompt = () => document.getElementById("pickup-hud-prompt") as HTMLElement;

  it("brings back the prompt underneath when the top one is withdrawn", () => {
    showPickupPrompt("pickup", "PRESS [F] TO SWAP TO RIOTGUN");
    showPickupPrompt("dropped", "PRESS [F] TO SWAP TO RLAUNCHER");
    expect(prompt().textContent).toContain("RLAUNCHER");

    hidePickupPrompt("dropped");
    expect(prompt().style.opacity).toBe("1");
    expect(prompt().textContent).toContain("RIOTGUN");

    hidePickupPrompt("pickup");
    expect(prompt().style.opacity).toBe("0");
  });

  it("leaves another system's prompt alone", () => {
    showPickupPrompt("dropped", "PRESS [F] TO SWAP TO RLAUNCHER");
    hidePickupPrompt("pickup");
    expect(prompt().style.opacity).toBe("1");
    hidePickupPrompt("dropped");
  });
});
