import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bunExecutable } from "../../../../../scripts/benchmarks/runtime-command.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const index = process.argv.indexOf("--bun");
const bun = bunExecutable(index < 0 ? "bun" : process.argv[index + 1]);
const scenario = ["src/games/fps/cli/server-fuzz.ts", "--ticks", "10000", "--seed", "42"];
const checksums = [];
for (const [runtime, executable, args] of [
  ["node", process.execPath, [path.join(root, "node_modules/vite-node/vite-node.mjs"), ...scenario]],
  ["bun", bun, ["run", ...scenario]],
]) {
  const output = execFileSync(executable, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60000 });
  const checksum = output.match(/Checksums match: (\d+)/)?.[1];
  assert.ok(checksum, `${runtime}: missing determinism result`);
  checksums.push(checksum);
  console.log(`${runtime}: 10000 ticks, seed 42, checksum ${checksum}`);
}
assert.equal(checksums[0], checksums[1], "Node/Bun simulation divergence");
console.log("Runtime equivalence passed");
