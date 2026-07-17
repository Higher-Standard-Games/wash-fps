/**
 * fps client → fps server layering guard (QA-14).
 *
 * The client must not import the game's SERVER code (ballistics, systems,
 * weapon table) — that coupled the presentation layer to server internals and
 * pulled three WeaponDef concepts together. Shared code (`shared/…`, including
 * `shared/server/*` simulation types) is fine; this only forbids reaching into
 * `src/games/<game>/server/`.
 *
 * Resolves every relative/dynamic import and fails if it lands under a game's
 * server directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_ROOT = path.resolve(__dirname, "..");
const IMPORT_RE = /(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("fps client imports no game server code", () => {
  it("no file under client/ resolves an import into games/*/server/", () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(CLIENT_ROOT)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_RE)) {
        const spec = match[1];
        const resolved = path.resolve(path.dirname(file), spec).replace(/\\/g, "/");
        if (/\/games\/[^/]+\/server\//.test(`${resolved}/`)) {
          offenders.push(`${path.relative(CLIENT_ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(offenders, `fps client must not import game server code:\n${offenders.join("\n")}`).toEqual([]);
  });
});
