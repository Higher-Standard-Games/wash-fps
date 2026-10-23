import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRecipe } from "../../../../../engine/editor/server/BuildRecipe";
import {
  localCompilerBin,
  resolveCompilerConfig,
  splitCompilerOptions,
} from "../../../../../engine/editor/server/CompilerConfig";
import { clearGameCompilerProfile } from "../../../../../engine/editor/server/GameCompilerProfile";
import { registerFpsCompilerProfile } from "../FpsCompilerProfile";

beforeEach(registerFpsCompilerProfile);
afterEach(clearGameCompilerProfile);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Washoi compiler configuration and recipe", () => {
  it("uses platform-specific names for the repository-local binaries", () => {
    expect(localCompilerBin("/repo", "makebsp", "win32")).toBe(path.join("/repo", "tools", "makebsp", "makebsp.exe"));
    expect(localCompilerBin("/repo", "makelight", "win32")).toBe(
      path.join("/repo", "tools", "makebsp", "makelight.exe"),
    );
    expect(localCompilerBin("/repo", "makebsp", "linux")).toBe(path.join("/repo", "tools", "makebsp", "makebsp"));
    expect(localCompilerBin("/repo", "makelight", "linux")).toBe(path.join("/repo", "tools", "makebsp", "makelight"));
  });

  it("resolves local tools, the tracked Washoi profile, and public/data outside the repository cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shagged-local-config-"));
    roots.push(root);
    const launchCwd = path.join(root, "launch");
    await mkdir(launchCwd);
    await mkdir(path.join(root, "tools", "makebsp"), { recursive: true });
    await mkdir(path.join(root, "editor", "makebspdata"), { recursive: true });
    await mkdir(path.join(root, "public", "data"), { recursive: true });
    await writeFile(localCompilerBin(root, "makebsp"), "test", { mode: 0o755 });
    await writeFile(localCompilerBin(root, "makelight"), "test", { mode: 0o755 });
    await writeFile(path.join(root, "editor", "makebspdata", "washoi.json"), "{}");

    const config = await resolveCompilerConfig({}, {}, launchCwd, root);
    expect(config).toMatchObject({
      available: true,
      reason: null,
      makebspBin: localCompilerBin(root, "makebsp"),
      makelightBin: localCompilerBin(root, "makelight"),
      mediaRoot: path.join(root, "public", "data"),
      toolchainRoot: path.join(root, "editor"),
    });
    const deployed = path.join(root, "tools", "makebsp", "makebspdata", "washoi.json");
    expect(await readFile(deployed, "utf8")).toBe("{}");
    await writeFile(path.join(root, "editor", "makebspdata", "washoi.json"), '{"gameDir":""}');
    await resolveCompilerConfig({}, {}, launchCwd, root);
    expect(await readFile(deployed, "utf8")).toBe('{"gameDir":""}');
  });

  it("maps quality tiers to the checked NetRadiant build menu", () => {
    expect(buildRecipe("fast", "/media", "/job/map.map")).toEqual({
      bsp: ["-game", "washoi", "-fs_basepath", "/media", "-leaktest", "-fast", "-samplesize", "8", "/job/map.map"],
      light: ["-game", "washoi", "-fs_basepath", "/media", "-fast", "/job/map.map"],
    });
    expect(buildRecipe("default", "/media", "/job/map.map").bsp).toEqual([
      "-game",
      "washoi",
      "-fs_basepath",
      "/media",
      "/job/map.map",
    ]);
    expect(buildRecipe("release", "/media", "/job/map.map").light).toEqual([
      "-game",
      "washoi",
      "-fs_basepath",
      "/media",
      "-upscale",
      "/job/map.map",
    ]);
  });

  it("resolves configured binaries and requires the Washoi profile and media", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "shagged-config-"));
    roots.push(root);
    const toolchain = path.join(root, "toolchain");
    const media = path.join(root, "media");
    await mkdir(path.join(toolchain, "makebspdata"), { recursive: true });
    await mkdir(media);
    const makebsp = path.join(toolchain, "makebsp.exe");
    const makelight = path.join(toolchain, "makelight.exe");
    await writeFile(makebsp, "test", { mode: 0o755 });
    await writeFile(makelight, "test", { mode: 0o755 });
    await writeFile(path.join(toolchain, "makebspdata", "washoi.json"), "{}");
    const { overrides, remaining } = splitCompilerOptions([
      "--makebsp-bin",
      makebsp,
      "--makelight-bin",
      makelight,
      "--media-root",
      media,
      "--toolchain-root",
      toolchain,
      "--default-quality",
      "release",
      "--port",
      "9011",
    ]);
    expect(remaining).toEqual(["--port", "9011"]);
    const ready = await resolveCompilerConfig(overrides, { SHAGGED_DEFAULT_QUALITY: "fast" }, root);
    expect(ready).toMatchObject({ available: true, reason: null, defaultQuality: "release" });
    const adjacentProfile = await resolveCompilerConfig({ ...overrides, toolchainRoot: undefined }, {}, root);
    expect(adjacentProfile).toMatchObject({ available: true, toolchainRoot: toolchain });
    const other = path.join(root, "other");
    await mkdir(path.join(other, "makebspdata"), { recursive: true });
    await writeFile(path.join(other, "makebspdata", "washoi.json"), "{}");
    await rm(path.join(toolchain, "makebspdata", "washoi.json"));
    expect((await resolveCompilerConfig({ ...overrides, toolchainRoot: other }, {}, root)).available).toBe(false);
    expect((await resolveCompilerConfig(overrides, {}, root)).reason).toMatch(/profile or media/);
  });
});
