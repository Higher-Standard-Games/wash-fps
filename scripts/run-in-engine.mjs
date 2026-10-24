import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Game commands use the assembled root for media, storage and server artifacts.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const application = fileURLToPath(new URL("../", import.meta.url));
const manifest = path.join(root, "package.json");
if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, "utf8")).name !== "shag-engine") {
  throw new Error(
    "Washoi commands require this checkout at <SHAG>/src/games/fps. Install dependencies at the SHAG root.",
  );
}

const [runtime, ...args] = process.argv.slice(2);
let executable = process.execPath;
if (runtime === "npm") {
  if (!process.env.npm_execpath) throw new Error("Launch npm command proxies through npm run.");
  args.unshift(process.env.npm_execpath, "--prefix", root);
} else if (runtime === "bun") {
  const { bunExecutable } = await import("../../../../scripts/benchmarks/runtime-command.mjs");
  executable = bunExecutable("bun");
} else if (runtime !== "node") {
  throw new Error("Expected node, npm or bun followed by command arguments.");
}

const child = spawn(executable, args, {
  cwd: root,
  env: { ...process.env, SHAG_APP: application },
  stdio: "inherit",
  windowsHide: true,
});
const onInterrupt = () => {
  // Windows console Ctrl+C already reaches the child; kill(SIGINT) would
  // terminate it before its own server/fixture cleanup handler can run.
  if (process.platform !== "win32") child.kill("SIGINT");
};
const onTerminate = () => child.kill("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  process.exitCode = code ?? (signal ? 1 : 0);
});
