import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GameServer } from "../GameServer";

/**
 * The game runs at one fixed tick rate, 125 Hz, defined once in the shared physics
 * constants. These tests keep it that way: the server refuses another rate, and no
 * gameplay code spells the number out again.
 */
const fpsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNED = ["server", "simulation", "world", "liquid"];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Code only: block and line comments removed, so prose may still mention 125 Hz. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("fixed 125 Hz tick rate", () => {
  it("is refused by the server at any other rate", () => {
    const config = { port: 0, tickRate: 100, snapshotRate: 50, serverName: "t", mapName: "m", maxClients: 2 };
    expect(() => new GameServer(config as never)).toThrow(/tickRate must be 125/);
  });

  it("is not written out as a literal in gameplay code", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sourceFiles(path.join(fpsRoot, dir))) {
        const lines = code(fs.readFileSync(file, "utf8")).split("\n");
        lines.forEach((line, index) => {
          if (/\b125\b/.test(line)) offenders.push(`${path.relative(fpsRoot, file)}:${index + 1}  ${line.trim()}`);
        });
      }
    }
    expect(offenders, "use DEFAULT_PHYSICS_TICK_RATE from @shared/server/simulation/physics/constants").toEqual([]);
  });
});
