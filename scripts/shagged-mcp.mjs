#!/usr/bin/env node
/**
 * Launches the SHAGGED MCP server (src/games/fps/cli/shagged-mcp.ts) under vite-node.
 *
 * stdout is the MCP protocol channel, but vite-node and the map, bot and
 * compiler code can print to stdout before the server takes over its console.
 * Only JSON-RPC messages are forwarded to stdout; every other line goes to
 * stderr, where MCP clients expect logs.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("../../../../node_modules/vite-node/vite-node.mjs", import.meta.url)), "src/games/fps/cli/shagged-mcp.ts"],
  { cwd: root, stdio: ["pipe", "pipe", "inherit"] },
);

process.stdin.pipe(child.stdin);
createInterface({ input: child.stdout }).on("line", (line) => {
  if (line.startsWith("{") && line.includes('"jsonrpc"')) process.stdout.write(`${line}\n`);
  else if (line.trim()) process.stderr.write(`${line}\n`);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
