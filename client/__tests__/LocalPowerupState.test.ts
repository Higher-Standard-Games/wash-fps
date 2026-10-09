/**
 * The local player's powerup timers. A round start respawns a Quad carrier alive
 * and the server takes the Quad away; the next snapshot without its
 * `powerup_state` has to end it, or the HUD timer and the Quad fire sound carry
 * into the new round on the old countdown.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clearLocalPowerups, isLocalPowerupActive, keepOnlyLocalPowerups, setLocalPowerup } from "../LocalPowerupState";

describe("local powerup timers", () => {
  afterEach(() => clearLocalPowerups());

  it("ends a powerup a snapshot no longer reports, before its countdown runs out", () => {
    setLocalPowerup("quad", 25);
    keepOnlyLocalPowerups(new Set(["quad"]));
    expect(isLocalPowerupActive("quad")).toBe(true);

    keepOnlyLocalPowerups(new Set());
    expect(isLocalPowerupActive("quad")).toBe(false);
  });
});
