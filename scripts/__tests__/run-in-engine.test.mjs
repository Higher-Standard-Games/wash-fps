import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../run-in-engine.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../../../../", import.meta.url));

test("preserves literal arguments, root-relative paths, selected application and child failure", () => {
  const payload = "space ; $value & literal";
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "node",
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(),app:process.env.SHAG_APP,args:process.argv.slice(1)}));process.exitCode=7;",
      payload,
    ],
    { cwd: os.tmpdir(), encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 7);
  const output = JSON.parse(result.stdout);
  assert.equal(path.resolve(output.cwd), path.resolve(root));
  assert.equal(path.resolve(output.app), path.join(path.resolve(root), "src/games/fps"));
  assert.deepEqual(output.args, [payload]);
});

test("a standalone game checkout fails explicitly before launching a command", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wash-command-"));
  const resolved = path.resolve(directory);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith("wash-command-"));
  try {
    const target = path.join(directory, "src/games/fps/scripts/run-in-engine.mjs");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(runner, target);
    const result = spawnSync(process.execPath, [target, "node", "-e", "throw Error('must not launch')"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /require this checkout at <SHAG>/);
    assert.doesNotMatch(result.stderr, /must not launch/);
  } finally {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
