import path from "node:path";
import type { BuildQuality } from "../../../../engine/editor/server/BuildRecipe";
import {
  type GameCompilerProfile,
  registerGameCompilerProfile,
} from "../../../../engine/editor/server/GameCompilerProfile";

/** Washoi's NetRadiant build menu, expressed as argv instead of shell text. */
export function buildFpsRecipe(quality: BuildQuality, mediaRoot: string, mapFile: string) {
  const common = ["-game", "washoi", "-fs_basepath", mediaRoot];
  const bsp = [...common];
  const light = [...common];
  if (quality === "fast") {
    bsp.push("-leaktest", "-fast", "-samplesize", "8");
    light.push("-fast");
  } else if (quality === "release") {
    light.push("-upscale");
  }
  bsp.push(mapFile);
  light.push(mapFile);
  return { bsp, light };
}

const fpsCompilerProfile: GameCompilerProfile = {
  id: "washoi",
  displayName: "Washoi",
  localToolchainRoot: (repoRoot) => path.join(repoRoot, "editor"),
  buildRecipe: buildFpsRecipe,
};

export function registerFpsCompilerProfile(): void {
  registerGameCompilerProfile(fpsCompilerProfile);
}
