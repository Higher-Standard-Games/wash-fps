import path from "node:path";
import { isBuildQuality } from "../../../engine/editor/server/BuildRecipe";
import { CompileJobs } from "../../../engine/editor/server/CompileJobs";
import { resolveCompilerConfig, splitCompilerOptions } from "../../../engine/editor/server/CompilerConfig";
import { MapStore } from "../../../engine/editor/server/MapStore";
import { resolveServerConfig } from "../../../engine/editor/server/ServerConfig";
import { registerFpsCompilerProfile } from "../editor/server/FpsCompilerProfile";
import { registerFpsMapAnalysis } from "../editor/server/FpsMapAnalysis";

registerFpsCompilerProfile();
registerFpsMapAnalysis();

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: npm run shagged:compile -- <mapname> [--quality fast|default|release] [--force] [--maps-root DIR] [--publish-root DIR] [--makebsp-bin FILE] [--makelight-bin FILE] [--media-root DIR] [--toolchain-root DIR] [--check-config]",
  );
  process.exit(0);
}

try {
  const checkConfig = args.includes("--check-config");
  const force = args.includes("--force");
  const { overrides, remaining } = splitCompilerOptions(
    args.filter((arg) => arg !== "--check-config" && arg !== "--force"),
  );
  let name: string | undefined;
  const serverArgs: string[] = [];
  let qualityInput: string | undefined;
  for (let index = 0; index < remaining.length; index++) {
    if (remaining[index] === "--quality") {
      qualityInput = remaining[++index];
      if (!qualityInput) throw new Error("Missing --quality value");
    } else if (remaining[index] === "--maps-root" || remaining[index] === "--publish-root") {
      const flag = remaining[index];
      const value = remaining[++index];
      if (!value) throw new Error(`Missing ${flag} value`);
      serverArgs.push(flag, value);
    } else if (!remaining[index].startsWith("--") && !name) {
      name = remaining[index];
    } else throw new Error(`Unknown compile option: ${remaining[index]}`);
  }
  const server = resolveServerConfig(serverArgs);
  const compiler = await resolveCompilerConfig(overrides);
  if (checkConfig) {
    console.log(JSON.stringify({ ...compiler, mapsRoot: server.mapsRoot, publishRoot: server.publishRoot }, null, 2));
    process.exit(compiler.available ? 0 : 1);
  }
  if (!name) throw new Error("Map name is required");
  const quality = qualityInput ?? compiler.defaultQuality;
  if (!isBuildQuality(quality)) throw new Error(`Unsupported build quality: ${quality}`);
  const store = new MapStore(server.mapsRoot);
  await store.init();
  const saved = await store.load(name);
  if (!saved) throw new Error(`Saved map not found: ${name}`);
  const jobs = new CompileJobs(
    store,
    compiler,
    path.resolve(server.mapsRoot, "../../../index", "jobs"),
    undefined,
    server.publishRoot,
  );
  const requested = await jobs.request(name, saved.revision, quality, force);
  const completed = await jobs.wait(requested.id);
  if (!completed) throw new Error("Compile job disappeared");
  console.log(JSON.stringify(completed, null, 2));
  if (completed.state !== "playable") process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
