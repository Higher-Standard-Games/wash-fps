import { MapStore } from "../../../engine/editor/server/MapStore";
import { resolveServerConfig } from "../../../engine/editor/server/ServerConfig";
import { createShaggedHttpServer } from "../../../engine/editor/server/ShaggedHttpServer";
import { registerFpsEditorCatalog } from "../editor/FpsEditorCatalog";
import { registerFpsCompilerProfile } from "../editor/server/FpsCompilerProfile";
import { registerFpsMapAnalysis } from "../editor/server/FpsMapAnalysis";

registerFpsEditorCatalog();
registerFpsCompilerProfile();
registerFpsMapAnalysis();

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: npm run shagged:server -- [--maps-root DIR] [--publish-root DIR] [--port N] [--ui-origin ORIGIN] [--makebsp-bin FILE] [--makelight-bin FILE] [--media-root DIR] [--toolchain-root DIR] [--default-quality fast|default|release] [--check-config]",
  );
  process.exit(0);
}

try {
  const checkConfig = args.includes("--check-config");
  const { overrides, remaining } = splitCompilerOptions(args.filter((arg) => arg !== "--check-config"));
  const config = resolveServerConfig(remaining);
  const compiler = await resolveCompilerConfig(overrides);
  if (checkConfig) {
    console.log(
      JSON.stringify(
        { ...compiler, mapsRoot: config.mapsRoot, publishRoot: config.publishRoot, port: config.port },
        null,
        2,
      ),
    );
    process.exit(compiler.available ? 0 : 1);
  }
  const store = new MapStore(config.mapsRoot);
  await store.init();
  const jobs = new CompileJobs(
    store,
    compiler,
    path.resolve(config.mapsRoot, "../../../index", "jobs"),
    undefined,
    config.publishRoot,
  );
  const server = createShaggedHttpServer(store, config, jobs);
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`SHAGGED map service: http://127.0.0.1:${config.port}`);
    console.log(`Maps root: ${config.mapsRoot}`);
    console.log(
      compiler.available
        ? "Save/Open, Compile and Playtest delivery ready"
        : `Save/Open ready; Compile unavailable: ${compiler.reason}`,
    );
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

import path from "node:path";
import { CompileJobs } from "../../../engine/editor/server/CompileJobs";
import { resolveCompilerConfig, splitCompilerOptions } from "../../../engine/editor/server/CompilerConfig";
