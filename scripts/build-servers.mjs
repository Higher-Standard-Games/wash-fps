import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const outdir = path.resolve(root, process.argv[2] ?? "dist-server");
// Build beside the live bundles and swap at the end: a lobby spawns match
// servers from this directory at any moment, and must never load a half-written
// bundle. Running processes already hold their whole bundle in memory.
const staging = `${outdir}.building-${process.pid}`;
const previous = `${outdir}.previous-${process.pid}`;

await rm(staging, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    "headless-netserver-v2": "src/games/fps/cli/headless-netserver-v2.ts",
    "lobby-server": "src/games/fps/cli/lobby-server.ts",
    "bot-server": "src/games/fps/cli/bot-server.ts",
    ServerBenchmarkClient: "src/cli/ServerBenchmarkClient.ts",
    ServerRuntimeProbe: "src/cli/ServerRuntimeProbe.ts",
  },
  outdir: staging,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // TensorFlow loads native modules at run time and is imported dynamically.
  external: ["ws", "@tensorflow/*"],
  tsconfig: "tsconfig.json",
  sourcemap: "external",
  metafile: true,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
await writeFile(path.join(staging, "meta.json"), JSON.stringify(result.metafile, null, 2));

// Windows briefly locks freshly written files (indexers, virus scanners), so a
// rename can fail with EPERM/EBUSY for a moment after the build.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

let hadPrevious = true;
await renameWithRetry(outdir, previous).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  hadPrevious = false;
});
try {
  await renameWithRetry(staging, outdir);
} catch (error) {
  if (hadPrevious) await renameWithRetry(previous, outdir);
  throw error;
}
await rm(previous, { recursive: true, force: true });
