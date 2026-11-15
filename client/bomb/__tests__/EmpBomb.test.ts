import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { describe, expect, it } from "vitest";
import { purpleGlowMask, purpleGlowWeight } from "../EmpBombModel";
import { EmpCorePlugin } from "../EmpCorePlugin";

describe("EMP bomb purple glow mask", () => {
  it("glows purple texels and leaves grey, white, black, red and blue ones dark", () => {
    expect(purpleGlowWeight(190, 30, 240)).toBe(1);
    expect(purpleGlowWeight(90, 90, 90)).toBe(0);
    expect(purpleGlowWeight(255, 255, 255)).toBe(0);
    expect(purpleGlowWeight(0, 0, 0)).toBe(0);
    expect(purpleGlowWeight(255, 40, 40)).toBe(0);
    expect(purpleGlowWeight(30, 60, 255)).toBe(0);
  });

  it("fades in as red and blue pull ahead of green", () => {
    const faint = purpleGlowWeight(110, 70, 120);
    const clear = purpleGlowWeight(140, 70, 150);
    expect(faint).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(faint);
    expect(clear).toBeLessThan(1);
  });

  it("keeps a glowing texel's own colour and blacks out the rest, opaque", () => {
    const mask = purpleGlowMask(new Uint8Array([190, 30, 240, 0, 90, 90, 90, 255]));
    expect(Array.from(mask)).toEqual([190, 30, 240, 255, 0, 0, 0, 255]);
  });
});

describe("EMP core shader", () => {
  // The custom code does not read the material, so a bare prototype call is enough.
  const code = (type: string, language: ShaderLanguage) =>
    EmpCorePlugin.prototype.getCustomCode.call({}, type, language) ?? {};

  it("passes the model-space position from vertex to fragment in both languages", () => {
    expect(code("vertex", ShaderLanguage.GLSL).CUSTOM_VERTEX_MAIN_END).toBe("vEmpPos = positionUpdated;");
    expect(code("vertex", ShaderLanguage.WGSL).CUSTOM_VERTEX_MAIN_END).toBe("vertexOutputs.vEmpPos = positionUpdated;");
  });

  it("samples the albedo texture outside any branch, so WGSL accepts it", () => {
    for (const language of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const fragment = code("fragment", language).CUSTOM_FRAGMENT_BEFORE_FOG;
      expect(fragment).toContain("albedoSampler");
      expect(fragment).not.toMatch(/\bif\s*\(/);
    }
  });
});
