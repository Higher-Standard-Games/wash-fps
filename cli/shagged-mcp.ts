/**
 * SHAGGED MCP server (stdio): lets AI clients build Washoi maps through the
 * same typed operations, compile pipeline and report as the `shagged` CLI.
 *
 *   npm run shagged:mcp
 *
 * Maps are documents under server-data/shagged/agent/<mapName>.json, and open
 * in the in-engine editor once compiled (Server Open). See
 * docs/manual/guides/shagged-api.md and docs/research/SHAGGED_API.md.
 */

// stdout carries the protocol. Everything else that logs (map, bot and
// compiler code) goes to stderr, before any of it is imported.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyOperations, type EditOp, emptyDocument, OperationError } from "../../../engine/editor/api/Operations";
import { type EditorDocumentData, migrateDocument, validateDocument } from "../../../engine/editor/EditorDocument";
import { BRUSH_ENTITY_CLASSES, EDITOR_POINT_CLASSES } from "../../../engine/editor/EntityCatalog";
import { createRoomTemplate } from "../../../engine/editor/RoomTemplate";
import {
  compileDocument,
  describeDocument,
  healthOf,
  mapReport,
  PipelineError,
  withTextureSizes,
} from "../../../engine/editor/server/AgentPipeline";
import { readCompileJob, readCompileLog } from "../../../engine/editor/server/CompileJobs";
import { documentSnapshot, queryDocument } from "../../../engine/editor/server/DocumentInspection";
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

const ROOT = path.resolve("server-data/shagged/agent");
const GUIDE = path.resolve("docs/manual/guides/shagged-api.md");
const MAP_NAME = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, "1–48 lowercase letters, digits or underscores, starting with a letter")
  .describe("Map ID, e.g. arena1. Also the name to play it with: map <mapName>.");
const QUALITY = z.enum(["fast", "default", "release"]).optional().describe("Compile quality. Default fast.");
const VECTOR = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });

const docPath = (mapName: string) => path.join(ROOT, `${mapName}.json`);

function load(mapName: string): EditorDocumentData {
  const file = docPath(mapName);
  if (!existsSync(file)) throw new PipelineError(`no map "${mapName}"; create it with shagged_new_map`);
  const doc = migrateDocument(JSON.parse(readFileSync(file, "utf8")));
  validateDocument(doc);
  return doc;
}

/** Write via a temporary file, so a crash never leaves half a document. */
function save(doc: EditorDocumentData): void {
  mkdirSync(ROOT, { recursive: true });
  const file = docPath(doc.mapName!);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** One edit at a time per map, so parallel tool calls cannot interleave read-modify-write. */
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(mapName: string, work: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(mapName) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => withFileLock(path.join(ROOT, ".locks", mapName), async () => work()));
  locks.set(mapName, next);
  return next.finally(() => {
    if (locks.get(mapName) === next) locks.delete(mapName);
  });
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Run a tool body; results and errors both come back as JSON text the model can read. */
async function run(work: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work(), null, 2) }] };
  } catch (error) {
    const body =
      error instanceof OperationError
        ? { ok: false, error: error.message, index: error.index, operation: error.operation }
        : error instanceof PipelineError
          ? { ok: false, error: error.message, ...error.details }
          : { ok: false, error: error instanceof Error ? error.message : String(error) };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
  }
}

const server = new McpServer({ name: "shagged", version: "0.1.0" });

server.registerResource(
  "guide",
  "shagged://guide",
  {
    title: "SHAGGED scripting guide",
    description:
      "Coordinates, every operation with its fields, a worked example, mapping rules and how to read the report.",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: readFileSync(GUIDE, "utf8") }] }),
);

server.registerTool(
  "shagged_guide",
  {
    title: "Read the mapping guide",
    description:
      "Returns the SHAGGED scripting guide: Quake coordinates (Z up), every operation and its fields, a worked two-room example, the mapping rules (player size, step and jump height, sealing, lights, spawns) and how to read the report. Read it before building a map.",
    annotations: { readOnlyHint: true },
  },
  async () => run(() => readFileSync(GUIDE, "utf8")),
);

server.registerTool(
  "shagged_new_map",
  {
    title: "Create a map",
    description:
      'Creates an empty map document, or the sealed 512×512×256 test room with a spawn and a light (template "room").',
    inputSchema: {
      mapName: MAP_NAME,
      template: z.enum(["empty", "room"]).optional().describe("Default empty."),
      replace: z.boolean().optional().describe("Replace an existing map of this name. Default false."),
    },
  },
  async ({ mapName, template, replace }) =>
    run(() =>
      exclusive(mapName, () => {
        if (existsSync(docPath(mapName)) && !replace)
          throw new PipelineError(`map "${mapName}" exists; pass replace: true to start over`);
        const doc = template === "room" ? createRoomTemplate() : emptyDocument();
        doc.mapName = mapName;
        validateDocument(doc);
        save(doc);
        return describeDocument(doc);
      }),
    ),
);

server.registerTool(
  "shagged_list_maps",
  {
    title: "List maps",
    description: "Lists the map documents this server manages.",
    annotations: { readOnlyHint: true },
  },
  async () =>
    run(() => ({
      maps: existsSync(ROOT)
        ? readdirSync(ROOT)
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.slice(0, -5))
        : [],
    })),
);

server.registerTool(
  "shagged_map_info",
  {
    title: "Describe a map",
    description:
      "Counts, bounds and entity classes; objects: true includes complete brushes (face materials/detail), patches (control points), entities and brush ownership.",
    inputSchema: { mapName: MAP_NAME, objects: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ mapName, objects }) => run(() => describeDocument(load(mapName), objects ?? false)),
);

server.registerTool(
  "shagged_read_document",
  {
    title: "Read a complete map snapshot",
    description:
      "Returns the complete validated authoring document, including schema/draft identity, revision, world keys, every face material, patch control point and brush-entity membership. Use expectedRevision when applying edits based on this snapshot.",
    inputSchema: { mapName: MAP_NAME },
    annotations: { readOnlyHint: true },
  },
  async ({ mapName }) => run(() => documentSnapshot(load(mapName))),
);

server.registerTool(
  "shagged_query_objects",
  {
    title: "Query map objects",
    description:
      "Returns complete matching objects with kind, authoring-space bounds and brush owner ID. Bounds are Quake Z-up; patch control hulls and brush-group bounds are conservative, point entities use origins rather than model extents. Stable paged results include revision and nextOffset.",
    inputSchema: {
      mapName: MAP_NAME,
      bounds: z.object({ min: VECTOR, max: VECTOR }).optional(),
      relation: z.enum(["intersects", "contained"]).optional(),
      kinds: z.array(z.enum(["brush", "patch", "entity", "brushEntity", "editorGroup"])).optional(),
      ids: z.array(z.string()).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ mapName, ...query }) => run(() => queryDocument(load(mapName), query)),
);

server.registerTool(
  "shagged_apply",
  {
    title: "Edit a map",
    description: [
      "Applies a batch of operations as one all-or-nothing transaction and saves the map. An error names the failing operation and changes nothing. face.material and creation with alignment: natural resolve image sizes from the catalog; omitted alignment preserves legacy repeats.",
      "Operations (fields in the guide): world.keys, box.create, box.update, convex.create, brush.rotate, brush.vertices (indexed world positions; rebuilds convex hull), brush.clip (plane normal/distance, keep back/front/both), brush.subtract (target ids, cutterId, optional removeCutter), gen.prism, patch.create, face.material (numeric sides for convex brushes), entity.place, entity.update, brushEntity.assign, editorGroup.create (editor-only object grouping), editorGroup.ungroup, object.move, object.duplicate, object.delete, brush.carve (box cutter, including convex targets), gen.room, gen.corridor, gen.connect (join two rooms), gen.stairs, gen.teleporter, gen.jumppad.",
      "patch.round creates cylinder/tube/cone/cap patch presets: min/max, axis (z default), optional thickness, capped, reverse, shader, group. Multiple surfaces form an editor group by default. Coordinates are Quake units with Z up. Returns created, changed and deleted IDs and Map Health issues.",
      "Use dryRun: true to preview without saving.",
    ].join(" "),
    inputSchema: {
      mapName: MAP_NAME,
      ops: z
        .array(z.object({ op: z.string().describe("Operation name, e.g. gen.room") }).passthrough())
        .min(1)
        .describe("Operations in order; each is an object with op and its fields."),
      dryRun: z.boolean().optional(),
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Reject if the map changed since the inspected snapshot."),
    },
  },
  async ({ mapName, ops, dryRun, expectedRevision }) =>
    run(() =>
      exclusive(mapName, async () => {
        const doc = load(mapName);
        if (expectedRevision !== undefined && doc.revision !== expectedRevision)
          throw new PipelineError("Map revision conflict", { expectedRevision, actualRevision: doc.revision });
        const result = applyOperations(doc, await withTextureSizes(ops as unknown as EditOp[]));
        if (!dryRun) save(result.doc);
        return {
          ok: true,
          dryRun: dryRun ?? false,
          revision: result.doc.revision,
          worldChanged: result.worldChanged,
          created: result.created,
          changed: result.changed,
          deleted: result.deleted,
          issues: result.issues,
        };
      }),
    ),
);

server.registerTool(
  "shagged_health",
  {
    title: "Check map health",
    description:
      "Map Health issues without compiling: missing spawns or required keys, broken target links, duplicate targetnames, unknown classes or shaders. Each names the object ID.",
    inputSchema: { mapName: MAP_NAME },
    annotations: { readOnlyHint: true },
  },
  async ({ mapName }) => run(async () => healthOf(load(mapName), await loadTextureCatalog())),
);

server.registerTool(
  "shagged_compile",
  {
    title: "Compile a map",
    description:
      "Compiles with MakeBSP and MakeLight and publishes a playable package (play it with: map <mapName>). Reports leaks. An unchanged map reuses its last build.",
    inputSchema: {
      mapName: MAP_NAME,
      quality: QUALITY,
      force: z.boolean().optional().describe("Rebuild even when source and all build inputs match."),
    },
  },
  async ({ mapName, quality, force }) =>
    run(() => exclusive(mapName, () => compileDocument(load(mapName), quality, force))),
);

server.registerTool(
  "shagged_compile_status",
  {
    title: "Inspect a compile job",
    description:
      "Read a durable compile job by ID, including current stage, native phase, diagnostics and the complete transcript path. Works across MCP sessions.",
    inputSchema: { jobId: z.string().uuid() },
    annotations: { readOnlyHint: true },
  },
  async ({ jobId }) =>
    run(async () => {
      const config = resolveServerConfig([]);
      const job = await readCompileJob(path.resolve(config.mapsRoot, "../../../index", "jobs"), jobId);
      if (!job) throw new PipelineError("compile job not found");
      return { ok: true, ...job };
    }),
);

server.registerTool(
  "shagged_compile_log",
  {
    title: "Read a compile transcript",
    description:
      "Read a byte-range page of the complete native transcript, including warnings no longer in the tail. Continue from nextOffset until it reaches size.",
    inputSchema: {
      jobId: z.string().uuid(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(65536).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ jobId, offset, limit }) =>
    run(async () => {
      const config = resolveServerConfig([]);
      return {
        ok: true,
        ...(await readCompileLog(path.resolve(config.mapsRoot, "../../../index", "jobs"), jobId, offset, limit)),
      };
    }),
);

server.registerTool(
  "shagged_report",
  {
    title: "Check a map end to end",
    description:
      "Map Health, then compile, then reachability of the compiled map: where a player can go from each spawn using the game's own movement (items some spawn cannot reach, spawns cut off from others), in Quake coordinates with the editor object ID. ok: true means all three passed. botNavigation reports the same for the bots' route graph, which misses stairs.",
    inputSchema: { mapName: MAP_NAME, quality: QUALITY, force: z.boolean().optional() },
  },
  async ({ mapName, quality, force }) => run(() => exclusive(mapName, () => mapReport(load(mapName), quality, force))),
);

server.registerTool(
  "shagged_inspect_installed_map",
  {
    title: "Inspect an installed reference map",
    description:
      "Read an indexed compiled BSP: world envelope (including scenery, not playable bounds), spawns, entity class counts and a paged used-material palette with face counts. No authoring document is required or changed.",
    inputSchema: {
      mapName: MAP_NAME,
      search: z.string().optional().describe("Filter used material names by all search words."),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ mapName, ...query }) => run(() => inspectInstalledMap(resolveServerConfig([]).publishRoot, mapName, query)),
);

server.registerTool(
  "shagged_textures",
  {
    title: "Find textures",
    description:
      "Texture names with their image sizes and tags. Use a name as given (no textures/ prefix) in box.create, gen.room or face.material; face.material fills in the size itself. common/* are tool textures (caulk, clip, trigger). The first call can take several seconds while the catalog is built.",
    inputSchema: {
      search: z.string().optional().describe("Words to match in the name or tags, e.g. 'metal floor' or 'blx dark'."),
      folder: z.string().optional().describe("Only this folder, e.g. blx or common."),
      limit: z.number().int().min(1).max(500).optional().describe("Default 50."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ search, folder, limit }) =>
    run(async () =>
      searchTextures(await loadTextureCatalog(resolveServerConfig([]).publishRoot), { search, folder, limit }),
    ),
);

server.registerTool(
  "shagged_models",
  {
    title: "Find prop models",
    description:
      "Search installed packaged and loose models for misc_model placement. Optional bounds inspect ASE/OBJ vertices or MD3 frames; other formats return unavailable. Bounds are asset coordinates, not collision or transformed placement bounds.",
    inputSchema: {
      search: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      includeBounds: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (query) => run(() => searchModelCatalog(resolveServerConfig([]).publishRoot, query)),
);

server.registerTool(
  "shagged_entity_classes",
  {
    title: "Find entity classes",
    description:
      "Gameplay and supported compiler-only entity classes, with documented keys and required ones marked. compilerOnly distinguishes baked authoring entities from runtime classes. Point classes go in entity.place, brush classes in brushEntity.assign.",
    inputSchema: {
      compilerOnly: z.boolean().optional().describe("Filter compiler-only classes (true) or runtime classes (false)."),
      search: z
        .string()
        .optional()
        .describe("Filter by text in the classname or section, e.g. weapon, spawn, trigger."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ search, compilerOnly }) =>
    run(() => {
      const needle = search?.toLowerCase() ?? "";
      const describe = (kind: "point" | "brush") => (c: (typeof EDITOR_POINT_CLASSES)[number]) => ({
        classname: c.classname,
        kind,
        compilerOnly: c.compilerOnly ?? false,
        ...(c.description ? { description: c.description } : {}),
        section: c.section,
        keys: c.keys.map((k) => ({
          name: k.name,
          label: k.label,
          default: k.defaultValue,
          required: k.required ?? false,
        })),
      });
      return [...EDITOR_POINT_CLASSES.map(describe("point")), ...BRUSH_ENTITY_CLASSES.map(describe("brush"))].filter(
        (c) =>
          (compilerOnly === undefined || c.compilerOnly === compilerOnly) &&
          (!needle || c.classname.toLowerCase().includes(needle) || c.section.toLowerCase().includes(needle)),
      );
    }),
);

await server.connect(new StdioServerTransport());
console.error(`[shagged-mcp] ready; maps in ${ROOT}`);
