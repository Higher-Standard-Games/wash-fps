/**
 * SHAGGED scripting CLI: edit a map document with typed operations, check it,
 * export it and compile it, without the browser editor. Output is JSON so
 * scripts and AI agents can read it; see docs/research/SHAGGED_API.md.
 *
 *   npm run shagged -- new <doc.json> [--name <mapid>] [--room] [--force]
 *   npm run shagged -- apply <doc.json> <ops.json|-> [--dry-run]
 *   npm run shagged -- info <doc.json> [--objects]
 *   npm run shagged -- health <doc.json>
 *   npm run shagged -- export <doc.json> [out.map]
 *   npm run shagged -- compile <doc.json> [--quality fast|default|release]
 *   npm run shagged -- report <doc.json> [--quality fast|default|release]
 *   npm run shagged -- textures [search words] [--folder <name>] [--limit <n>]
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyOperations, type EditOp, emptyDocument, OperationError } from "../../../engine/editor/api/Operations";
import { type EditorDocumentData, migrateDocument, validateDocument } from "../../../engine/editor/EditorDocument";
import { writeMap } from "../../../engine/editor/MapWriter";
import { createRoomTemplate } from "../../../engine/editor/RoomTemplate";
import {
  compileDocument,
  describeDocument,
  healthOf,
  mapReport,
  PipelineError,
  quietly,
  withTextureSizes,
} from "../../../engine/editor/server/AgentPipeline";
import { type DocumentQuery, documentSnapshot, queryDocument } from "../../../engine/editor/server/DocumentInspection";
import { withFileLock } from "../../../engine/editor/server/FileLock";
import { inspectInstalledMap } from "../../../engine/editor/server/InstalledMapInspection";
import { searchModelCatalog } from "../../../engine/editor/server/ModelLookup";
import { resolveServerConfig } from "../../../engine/editor/server/ServerConfig";
import { loadTextureCatalog, searchTextures } from "../../../engine/editor/server/TextureLookup";
import { registerFpsEditorCatalog } from "../editor/FpsEditorCatalog";
import { registerFpsCompilerProfile } from "../editor/server/FpsCompilerProfile";
import { registerFpsMapAnalysis } from "../editor/server/FpsMapAnalysis";

registerFpsEditorCatalog();
registerFpsCompilerProfile();
registerFpsMapAnalysis();

const USAGE = `Usage: npm run shagged -- <command> ...
  new <doc.json> [--name <mapid>] [--room] [--force]   create a document (optionally the sealed test room)
  apply <doc.json> <ops.json|-> [--dry-run] [--expected-revision N]  apply a batch atomically; optionally reject stale reads
  info <doc.json> [--objects]                          counts, bounds and (optionally) every object
  read <doc.json>                                      complete authoring snapshot
  query <doc.json> [query.json]                        paged object/region query
  health <doc.json>                                    Map Health issues
  export <doc.json> [out.map]                          deterministic .map source (stdout without a file)
  compile <doc.json> [--quality fast|default|release] [--force]  save, compile and publish; force bypasses reuse
  report <doc.json> [--quality ...] [--force]          health, compile, then reachability of the compiled map
  textures [search words] [--folder f] [--limit n]     find texture names and their image sizes
  inspect-bsp <mapName> [--search words] [--offset n] [--limit n]  inspect an installed reference map
  models [search words] [--offset n] [--limit n] [--bounds]  discover prop models`;

/** Writes stdout directly, so results still print while library logging is silenced. */
function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, extra: Record<string, unknown> = {}): never {
  out({ ok: false, error: message, ...extra });
  process.exit(1);
}

function readDoc(file: string): EditorDocumentData {
  if (!existsSync(file))
    throw new PipelineError(`no document at ${file}; create one with: npm run shagged -- new ${file}`);
  const doc = migrateDocument(JSON.parse(readFileSync(file, "utf8")));
  validateDocument(doc);
  return doc;
}

function writeDoc(file: string, doc: EditorDocumentData): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const documentLock = (file: string) =>
  path.join(path.resolve(path.dirname(file)), ".locks", path.basename(file, path.extname(file)));

function readOps(source: string): EditOp[] {
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.ops)) return parsed.ops;
    if (parsed && typeof parsed.op === "string") return [parsed];
  } catch {
    // Fall through to JSON Lines.
  }
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("//"))
    .map((line, index): EditOp => {
      try {
        return JSON.parse(line);
      } catch {
        return fail(`line ${index + 1} of the operations is not JSON`);
      }
    });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const positional = args.filter(
    (arg, index) =>
      !arg.startsWith("--") &&
      !args[index - 1]?.match(/^--(name|quality|folder|limit|expected-revision|search|offset)$/),
  );
  const [command, file, third] = positional;
  if (!command || flag("--help") || flag("-h")) {
    console.log(USAGE);
    return;
  }
  if (command === "models") {
    out(
      await quietly(() =>
        searchModelCatalog(resolveServerConfig([]).publishRoot, {
          search: positional.slice(1).join(" ") || undefined,
          offset: Number(value("--offset") ?? 0),
          limit: Number(value("--limit") ?? 50),
          includeBounds: flag("--bounds"),
        }),
      ),
    );
    return;
  }
  if (command === "inspect-bsp") {
    if (!file) fail("inspect-bsp needs an installed map name");
    out(
      await quietly(() =>
        inspectInstalledMap(resolveServerConfig([]).publishRoot, file, {
          search: value("--search"),
          offset: Number(value("--offset") ?? 0),
          limit: Number(value("--limit") ?? 100),
        }),
      ),
    );
    return;
  }
  if (command === "textures") {
    const catalog = await quietly(() => loadTextureCatalog(resolveServerConfig([]).publishRoot));
    const limit = value("--limit");
    out({
      ok: true,
      ...searchTextures(catalog, {
        search: positional.slice(1).join(" ") || undefined,
        folder: value("--folder"),
        limit: limit ? Number(limit) : undefined,
      }),
    });
    return;
  }
  if (!file) fail(`${command} needs a document path\n${USAGE}`);

  switch (command) {
    case "new": {
      await withFileLock(documentLock(file), async () => {
        if (existsSync(file) && !flag("--force")) throw new PipelineError(`${file} exists; pass --force to replace it`);
        const doc = flag("--room") ? createRoomTemplate() : emptyDocument();
        const name = value("--name");
        if (name) doc.mapName = name;
        validateDocument(doc);
        writeDoc(file, doc);
        out(describeDocument(doc));
      });
      return;
    }
    case "apply": {
      if (!third) fail("apply needs an operations file, or - for stdin");
      try {
        await withFileLock(documentLock(file), async () => {
          const doc = readDoc(file);
          if (flag("--expected-revision") && Number(value("--expected-revision")) !== doc.revision)
            throw new PipelineError("Map revision conflict", {
              expectedRevision: value("--expected-revision"),
              actualRevision: doc.revision,
            });
          const result = applyOperations(doc, await withTextureSizes(readOps(third)));
          const dryRun = flag("--dry-run");
          if (!dryRun) writeDoc(file, result.doc);
          out({
            ok: true,
            dryRun,
            revision: result.doc.revision,
            created: result.created,
            changed: result.changed,
            deleted: result.deleted,
            issues: result.issues,
          });
        });
      } catch (error) {
        if (error instanceof OperationError) fail(error.message, { index: error.index, operation: error.operation });
        throw error;
      }
      return;
    }
    case "info":
      out(describeDocument(readDoc(file), flag("--objects")));
      return;
    case "read":
      out(documentSnapshot(readDoc(file)));
      return;
    case "query":
      out(queryDocument(readDoc(file), third ? (JSON.parse(readFileSync(third, "utf8")) as DocumentQuery) : {}));
      return;
    case "health":
      out(healthOf(readDoc(file), await quietly(() => loadTextureCatalog())));
      return;
    case "export": {
      const source = writeMap(readDoc(file));
      if (third) {
        writeFileSync(third, source);
        out({ ok: true, file: third, bytes: Buffer.byteLength(source) });
      } else process.stdout.write(source);
      return;
    }
    case "compile": {
      const result = await quietly(() => compileDocument(readDoc(file), value("--quality"), flag("--force")));
      out(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "report": {
      const result = await mapReport(readDoc(file), value("--quality"), flag("--force"));
      out(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    default:
      fail(`unknown command ${command}\n${USAGE}`);
  }
}

// The compile job runner can leave handles open; the result is printed, so leave now.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) =>
    fail(error instanceof Error ? error.message : String(error), error instanceof PipelineError ? error.details : {}),
  );
