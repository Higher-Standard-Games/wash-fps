/**
 * Electrobolt viewmodel glow wiring (WO-EB1).
 *
 * The GLB's baked emissive channel is empty, so the energy coil rendered flat/
 * black. The fix wires the real `_glow.tga` as an additive emissive via the
 * `viewModel.glowTexture` field, applied in WeaponViewManager's gun path. The
 * material result itself is visual (needs a real GLB + scene), so this guard
 * only locks the def-side wiring so it can't be silently dropped.
 */
import { describe, expect, it } from "vitest";
import { ELECTROBOLT } from "../electrobolt";

describe("Electrobolt viewmodel glow (WO-EB1)", () => {
  it("wires the energy-coil glow map as an emissive glow texture", () => {
    expect(ELECTROBOLT.viewModel.glowTexture).toBe("/data/models/weapons/electrobolt/electrobolt_glow.tga");
  });

  it("keeps the glow map in the electrobolt model directory (matches shipped asset)", () => {
    const glow = ELECTROBOLT.viewModel.glowTexture ?? "";
    expect(glow.startsWith("/data/models/weapons/electrobolt/")).toBe(true);
    expect(glow.endsWith("_glow.tga")).toBe(true);
  });
});
