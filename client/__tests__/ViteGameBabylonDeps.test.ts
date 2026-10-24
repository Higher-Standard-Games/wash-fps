import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { resolveBrowserApplication } from "../../../../../scripts/browser-application";

it("prebundles Washoi's additional Babylon modules through its application descriptor", () => {
  const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  const files = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).fileNames;
  const modules = (sources: string[]) =>
    new Set(
      sources.flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/["'](@babylonjs\/[^"']+)["']/g)]
          .map((match) => match[1])
          .filter((value) => !value.includes("?") && !value.endsWith(".wasm")),
      ),
    );
  const isGame = (file: string) =>
    file.replace(/\\/g, "/").includes("/src/games/") || file.replace(/\\/g, "/").startsWith("src/games/");
  const engine = modules(files.filter((file) => !isGame(file)));
  const game = modules(files.filter(isGame));
  const additional = [...game].filter((value) => !engine.has(value)).sort();
  const application = resolveBrowserApplication(process.cwd(), "src/games/fps");
  expect([...application.optimizeDeps].sort(), "Run deps:babylon with SHAG_APP=src/games/fps").toEqual(additional);
  expect(resolveBrowserApplication(process.cwd(), "engine").optimizeDeps).toEqual([]);
});
