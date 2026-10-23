/**
 * Point entities in the SHAGGED document: the class catalog read from the
 * Washoi entities.def, the version 1 → 2 draft migration, validation of what
 * a .map value can hold, and deterministic export.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BoxBrush,
  type BrushEntity,
  EditorDocument,
  type EditorDocumentDataV1,
  ownerOf,
  type PointEntity,
  pruneBrushEntities,
} from "../../../../engine/editor/EditorDocument";
import {
  BRUSH_ENTITY_CLASSES,
  brushEntityShader,
  clearGameEntityCatalog,
  entityClass,
  missingRequiredKeys,
  POINT_ENTITY_CLASSES,
  parseEntityDefs,
} from "../../../../engine/editor/EntityCatalog";
import { writeMap } from "../../../../engine/editor/MapWriter";
import { MapParser } from "../../../../engine/loader/map/MapParser";
import { registerFpsEditorCatalog } from "../FpsEditorCatalog";

beforeEach(registerFpsEditorCatalog);
afterEach(clearGameEntityCatalog);

const spawn = (id: string, keys: Record<string, string> = {}): PointEntity => ({
  id,
  classname: "info_player_deathmatch",
  origin: { x: 0, y: 0, z: 24 },
  keys,
});

describe("entity catalog", () => {
  it("offers the gameplay point classes from the Washoi definitions, with their keys", () => {
    const names = POINT_ENTITY_CLASSES.map((entity) => entity.classname);
    expect(names).toContain("info_player_deathmatch");
    expect(names).toContain("light");
    expect(names).toContain("weapon_rocketlauncher");
    expect(names).toContain("item_armor_ra");
    expect(names).toContain("target_position");

    const light = entityClass("light");
    expect(light.section).toBe("LIGHTS");
    expect(light.mins).toEqual({ x: -16, y: -16, z: -16 });
    expect(light.maxs).toEqual({ x: 16, y: 16, z: 32 });
    expect(light.keys.find((key) => key.name === "light")).toEqual({
      name: "light",
      label: "Intensity",
      defaultValue: "300",
    });
    // origin is an editor field, not a free key
    expect(light.keys.some((key) => key.name === "origin")).toBe(false);
  });

  it("leaves out brush classes and the compiler-only and raw-.map-only sections", () => {
    const names = POINT_ENTITY_CLASSES.map((entity) => entity.classname);
    for (const excluded of ["worldspawn", "trigger_teleport", "func_door", "func_group", "misc_model", "info_npc"]) {
      expect(names).not.toContain(excluded);
    }
  });

  it("parses a definition block's colour, box, section and defaults", () => {
    const [parsed] = parseEntityDefs(
      [
        "// -----------------------------------------------------------------------------",
        "//  TEST SECTION  (point entities)",
        "// -----------------------------------------------------------------------------",
        "/*QUAKED thing (1 .5 0) (-8 -8 0) (8 8 16) ?",
        "  -------- KEYS --------",
        "  origin:",
        "  speed: Speed (default: 40)",
        "  speed: Duplicate line is ignored",
        "*/",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      classname: "thing",
      section: "TEST SECTION",
      color: [1, 0.5, 0],
      mins: { x: -8, y: -8, z: 0 },
      maxs: { x: 8, y: 8, z: 16 },
      keys: [{ name: "speed", label: "Speed", defaultValue: "40" }],
    });
  });

  it("gives an unknown classname a neutral marker instead of failing", () => {
    expect(entityClass("mod_custom_thing")).toMatchObject({ classname: "mod_custom_thing", section: "Other" });
  });
});

describe("document entities", () => {
  it("migrates a version 1 draft's test spawn into a spawn entity", () => {
    const v1: EditorDocumentDataV1 = {
      schemaVersion: 1,
      draftId: "draft-1",
      revision: 7,
      brushes: [],
      testSpawn: { x: 1, y: 2, z: 48 },
    };
    const data = new EditorDocument(v1).snapshot();
    expect(data.schemaVersion).toBe(2);
    expect(data.revision).toBe(7);
    expect(data.entities).toEqual([
      { id: "test-spawn", classname: "info_player_deathmatch", origin: { x: 1, y: 2, z: 48 }, keys: {} },
    ]);
    expect("testSpawn" in data).toBe(false);
  });

  it("rejects a value a .map cannot hold, a reserved key, and an ID shared with a brush", () => {
    const document = new EditorDocument();
    const reject = (entity: PointEntity) =>
      expect(() => document.transact((data) => data.entities.push(entity))).toThrow();
    reject(spawn("quote", { message: 'say "hi"' }));
    reject(spawn("newline", { message: "two\nlines" }));
    reject(spawn("reserved", { origin: "0 0 0" }));
    reject(spawn("badkey", { "bad key": "1" }));
    reject({ ...spawn("world"), classname: "worldspawn" });
    document.transact((data) =>
      data.brushes.push({ id: "shared", min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 8, z: 8 }, shader: "blx/blx_grid" }),
    );
    reject(spawn("shared"));
    expect(document.snapshot().entities).toHaveLength(0);
  });

  it("keeps keys the catalog doesn't know", () => {
    const document = new EditorDocument();
    document.transact((data) => data.entities.push(spawn("a", { angle: "90", _mod_flag: "on" })));
    expect(document.snapshot().entities[0].keys).toEqual({ angle: "90", _mod_flag: "on" });
  });
});

describe("entity export", () => {
  it("writes classname, origin, then keys in name order, entities in ID order", () => {
    const document = new EditorDocument();
    document.transact((data) => {
      data.entities.push(
        { id: "b", classname: "light", origin: { x: 0, y: 0, z: 128 }, keys: { light: "300", _color: "1 0.5 0" } },
        spawn("a", { angle: "90" }),
      );
    });
    const snapshot = document.snapshot();
    const source = writeMap(snapshot);
    expect(source).toBe(writeMap({ ...snapshot, entities: [...snapshot.entities].reverse() }));
    expect(source).toContain(
      [
        "{",
        '"classname" "info_player_deathmatch"',
        '"origin" "0 0 24"',
        '"angle" "90"',
        "}",
        "{",
        '"classname" "light"',
        '"origin" "0 0 128"',
        '"_color" "1 0.5 0"',
        '"light" "300"',
        "}",
      ].join("\n"),
    );
    const parsed = MapParser.parse(source);
    expect(parsed.map((entity) => entity.classname)).toEqual(["worldspawn", "info_player_deathmatch", "light"]);
    expect(parsed[2].properties.light).toBe("300");
  });
});

const box = (id: string, x = 0): BoxBrush => ({
  id,
  min: { x, y: 0, z: 0 },
  max: { x: x + 64, y: 64, z: 64 },
  shader: "blx/blx_grid",
});

describe("brush entities", () => {
  it("lists the trigger and mover classes, with required keys and without model or origin", () => {
    const names = BRUSH_ENTITY_CLASSES.map((entity) => entity.classname);
    for (const name of ["trigger_teleport", "trigger_push", "trigger_hurt", "func_door", "func_plat"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("worldspawn");
    expect(names).not.toContain("light");
    const teleport = entityClass("trigger_teleport");
    expect(teleport.keys).toEqual([{ name: "target", label: "Target Entity", required: true }]);
    const door = entityClass("func_door");
    expect(door.keys.find((key) => key.name === "angle")).toMatchObject({ required: true });
    expect(door.keys.some((key) => key.name === "model" || key.name === "origin")).toBe(false);
    expect(missingRequiredKeys("trigger_teleport", {})).toEqual(["target"]);
    expect(missingRequiredKeys("trigger_teleport", { target: "dest1" })).toEqual([]);
    expect(brushEntityShader("trigger_push")).toBe("common/trigger");
    expect(brushEntityShader("func_door")).toBeNull();
  });

  it("owns brushes by ID and refuses a missing brush, a second owner, an empty entity or a model key", () => {
    const document = new EditorDocument();
    document.transact((data) => data.brushes.push(box("a"), box("b", 64)));
    const entity = (brushIds: string[], keys: Record<string, string> = {}): BrushEntity => ({
      id: `door-${brushIds.join("")}`,
      classname: "func_door",
      keys,
      brushIds,
    });
    const reject = (value: BrushEntity) =>
      expect(() => document.transact((data) => data.brushEntities!.push(value))).toThrow();
    reject(entity(["missing"]));
    reject(entity([]));
    reject(entity(["a"], { model: "*1" }));
    reject(entity(["a"], { origin: "0 0 0" }));
    document.transact((data) => data.brushEntities!.push(entity(["a"])));
    reject({ ...entity(["a"]), id: "second" });
    expect(ownerOf(document.snapshot(), "a")?.id).toBe("door-a");
    expect(ownerOf(document.snapshot(), "b")).toBeUndefined();
  });

  it("prunes a deleted brush from its entity and drops an entity left empty", () => {
    const document = new EditorDocument();
    document.transact((data) => {
      data.brushes.push(box("a"), box("b", 64), box("c", 128));
      data.brushEntities!.push(
        { id: "door", classname: "func_door", keys: { angle: "-1" }, brushIds: ["a", "b"] },
        { id: "push", classname: "trigger_push", keys: {}, brushIds: ["c"] },
      );
    });
    document.transact((data) => {
      data.brushes = data.brushes.filter((brush) => brush.id !== "b" && brush.id !== "c");
      pruneBrushEntities(data);
    });
    expect(document.snapshot().brushEntities).toEqual([
      { id: "door", classname: "func_door", keys: { angle: "-1" }, brushIds: ["a"] },
    ]);
  });

  it("reads a draft saved before brush entities existed", () => {
    const data = new EditorDocument({
      schemaVersion: 2,
      draftId: "old",
      revision: 3,
      brushes: [box("a")],
      entities: [],
    }).snapshot();
    expect(data.brushEntities).toEqual([]);
  });

  it("moves owned brushes out of worldspawn into their entity, with no origin or model", () => {
    const document = new EditorDocument();
    document.transact((data) => {
      data.brushes.push(box("world"), box("tp", 64));
      data.brushEntities!.push({
        id: "e-tp",
        classname: "trigger_teleport",
        keys: { target: "dest1" },
        brushIds: ["tp"],
      });
      data.entities.push({
        id: "e-dest",
        classname: "misc_teleporter_dest",
        origin: { x: 512, y: 0, z: 24 },
        keys: { targetname: "dest1" },
      });
    });
    const source = writeMap(document.snapshot());
    const parsed = MapParser.parse(source);
    expect(parsed.map((entity) => entity.classname)).toEqual([
      "worldspawn",
      "misc_teleporter_dest",
      "trigger_teleport",
    ]);
    expect(parsed[0].brushes).toHaveLength(1);
    const trigger = parsed[2];
    expect(trigger.brushes).toHaveLength(1);
    expect(trigger.properties).toEqual({ classname: "trigger_teleport", target: "dest1" });
    expect(source).toBe(writeMap(document.snapshot()));
  });
});
