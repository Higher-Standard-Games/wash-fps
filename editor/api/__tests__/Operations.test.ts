import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearGameEntityCatalog } from "../../../../../engine/editor/EntityCatalog";
import { registerFpsEditorCatalog } from "../../FpsEditorCatalog";

beforeEach(registerFpsEditorCatalog);
afterEach(clearGameEntityCatalog);

import { generateCorridor, generateRoom } from "../../../../../engine/editor/api/Generators";
import {
  applyOperations,
  DEFAULT_SHADER,
  type EditOp,
  emptyDocument,
  OperationError,
} from "../../../../../engine/editor/api/Operations";
import type { BoxBrush, EditorDocumentData } from "../../../../../engine/editor/EditorDocument";
import { writeMap } from "../../../../../engine/editor/MapWriter";

const twoRooms: EditOp[] = JSON.parse(readFileSync(new URL("./fixtures/two-rooms.ops.json", import.meta.url), "utf8"));

const overlaps = (a: BoxBrush, b: BoxBrush) =>
  (["x", "y", "z"] as const).every((axis) => a.min[axis] < b.max[axis] && b.min[axis] < a.max[axis]);

function assertNoOverlaps(brushes: BoxBrush[]): void {
  for (let i = 0; i < brushes.length; i++)
    for (let j = i + 1; j < brushes.length; j++)
      expect(overlaps(brushes[i], brushes[j]), `${brushes[i].id} overlaps ${brushes[j].id}`).toBe(false);
}

describe("SHAGGED operations", () => {
  it("exports detail contents and preserves the flag through carving", () => {
    const { doc } = applyOperations(emptyDocument(), [
      {
        op: "box.create",
        id: "trim",
        min: { x: 0, y: 0, z: 0 },
        max: { x: 96, y: 32, z: 64 },
        shader: "blx/blx_grid",
        detail: true,
      },
      { op: "brush.carve", min: { x: 32, y: 0, z: 0 }, max: { x: 64, y: 32, z: 64 } },
    ]);
    expect(doc.brushes).toHaveLength(2);
    expect(doc.brushes.every((b) => b.detail === true)).toBe(true);
    expect(writeMap(doc)).toContain("blx/blx_grid 134217728 0 0");
    const reverted = applyOperations(
      doc,
      doc.brushes.map((b) => ({ op: "box.update", id: b.id, detail: false })),
    );
    expect(writeMap(reverted.doc)).not.toContain("134217728");
  });

  it("merges and removes worldspawn keys, preserving them through deterministic export", () => {
    const { doc, worldChanged } = applyOperations(emptyDocument(), [
      { op: "world.keys", keys: { message: "Relay Yard", ambient: "7", fog: "1900 0.05 0.065 0.09" } },
      { op: "world.keys", keys: { ambient: "", _color: "0.45 0.5 0.65" } },
    ]);
    expect(worldChanged).toBe(true);
    expect(doc.worldKeys).toEqual({ message: "Relay Yard", fog: "1900 0.05 0.065 0.09", _color: "0.45 0.5 0.65" });
    expect(writeMap(doc)).toContain('"message" "Relay Yard"');
    expect(writeMap(doc)).not.toContain('"ambient"');
    expect(applyOperations(doc, [{ op: "world.keys", keys: { message: "Relay Yard" } }]).worldChanged).toBe(false);
  });

  it("rejects worldspawn identity overrides and injected source atomically", () => {
    const invalid: Record<string, string>[] = [
      { classname: "light" },
      { origin: "0 0 0" },
      { model: "*1" },
      { fog: 'bad"\n}' },
    ];
    for (const keys of invalid) {
      const input = emptyDocument();
      expect(() => applyOperations(input, [{ op: "world.keys", keys }])).toThrow();
      expect(input.worldKeys).toBeUndefined();
    }
  });

  const curvedPatch: EditOp = {
    op: "patch.create",
    id: "reactor",
    shader: "blx/blx_grid",
    width: 3,
    height: 3,
    controlPoints: [0, 32, 64].map((z) =>
      [
        [0, 0],
        [32, 0],
        [32, 32],
      ].map(([x, y], col) => ({ x, y, z, u: col / 2, v: z / 64 })),
    ),
  };

  it("creates exportable curved patches without retaining caller-owned controls", () => {
    const operation = structuredClone(curvedPatch);
    const { doc, created } = applyOperations(emptyDocument(), [operation]);
    expect(created).toEqual(["reactor"]);
    expect(writeMap(doc)).toContain("patchDef2");
    if (operation.op !== "patch.create") throw new Error("patch fixture expected");
    operation.controlPoints[0][0].x = 999;
    expect(doc.patches?.[0].controlPoints[0][0].x).toBe(0);
    expect(() => applyOperations(doc, [curvedPatch])).toThrow(/already exists/);
  });

  it("rejects invalid patch grids atomically", () => {
    const input = emptyDocument();
    expect(() => applyOperations(input, [curvedPatch, { ...curvedPatch, id: "broken", width: 4 } as EditOp])).toThrow(
      /Invalid dimensions/,
    );
    expect(input.patches).toEqual([]);
    expect(() => applyOperations(input, [{ ...curvedPatch, controlPoints: [] } as EditOp])).toThrow(
      /Invalid control grid/,
    );
  });

  it("builds the two-room fixture with no health issues and identical bytes every time", () => {
    const first = applyOperations(emptyDocument("fixture"), twoRooms);
    const second = applyOperations({ ...emptyDocument("fixture"), draftId: first.doc.draftId }, twoRooms);
    expect(first.issues).toEqual([]);
    expect(first.created).toContain("hall-floor");
    expect(first.doc.revision).toBe(1);
    expect(writeMap(first.doc)).toBe(writeMap(second.doc));
    assertNoOverlaps(first.doc.brushes);
  });

  it("names objects deterministically when the caller does not", () => {
    const { doc, created } = applyOperations(emptyDocument(), [
      { op: "box.create", min: { x: 0, y: 0, z: 0 }, max: { x: 64, y: 64, z: 16 } },
      { op: "box.create", min: { x: 64, y: 0, z: 0 }, max: { x: 128, y: 64, z: 16 } },
      { op: "entity.place", classname: "info_player_deathmatch", origin: { x: 32, y: 32, z: 40 } },
    ]);
    expect(created).toEqual(["brush-1", "brush-2", "ent-1"]);
    expect(doc.brushes[0].shader).toBe(DEFAULT_SHADER);
    expect(DEFAULT_SHADER).toBe("common/caulk");
  });

  it("applies all or nothing and names the failing operation", () => {
    const input = emptyDocument();
    let caught: unknown;
    try {
      applyOperations(input, [
        { op: "box.create", id: "ok", min: { x: 0, y: 0, z: 0 }, max: { x: 64, y: 64, z: 16 } },
        { op: "box.create", id: "bad", min: { x: 64, y: 0, z: 0 }, max: { x: 0, y: 64, z: 16 } },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperationError);
    expect((caught as OperationError).index).toBe(1);
    expect((caught as OperationError).message).toContain("brush bad");
    expect(input.brushes).toEqual([]);
  });

  it("refuses duplicate IDs and unknown objects", () => {
    const { doc } = applyOperations(emptyDocument(), [
      { op: "box.create", id: "a", min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 8, z: 8 } },
    ]);
    expect(() =>
      applyOperations(doc, [{ op: "box.create", id: "a", min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 8, z: 8 } }]),
    ).toThrow(/already exists/);
    expect(() => applyOperations(doc, [{ op: "object.move", ids: ["nope"], delta: { x: 1, y: 0, z: 0 } }])).toThrow(
      /no object "nope"/,
    );
  });

  it("textures faces: tool shaders need no size, others do", () => {
    const base = applyOperations(emptyDocument(), [
      { op: "box.create", id: "w", min: { x: 0, y: 0, z: 0 }, max: { x: 64, y: 64, z: 64 } },
    ]).doc;
    const caulked = applyOperations(base, [{ op: "face.material", id: "w", faces: "all", shader: "common/caulk" }]);
    expect(Object.keys(caulked.doc.brushes[0].faces ?? {})).toHaveLength(6);
    expect(() =>
      applyOperations(base, [{ op: "face.material", id: "w", faces: ["+Z"], shader: "blx/blx_dark" }]),
    ).toThrow(/size/);
    const textured = applyOperations(base, [
      { op: "face.material", id: "w", faces: ["+Z"], shader: "blx/blx_dark", size: [256, 256] },
    ]);
    expect(textured.doc.brushes[0].faces?.["+Z"]?.size).toEqual([256, 256]);
  });

  it("makes trigger brush entities with the trigger shader, and deleting the brush removes the entity", () => {
    const { doc } = applyOperations(emptyDocument(), [
      { op: "box.create", id: "tp", min: { x: 0, y: 0, z: 0 }, max: { x: 64, y: 64, z: 64 }, shader: "blx/blx_dark" },
      {
        op: "brushEntity.assign",
        id: "teleporter",
        classname: "trigger_teleport",
        brushIds: ["tp"],
        keys: { target: "dest" },
      },
      {
        op: "entity.place",
        id: "dest",
        classname: "misc_teleporter_dest",
        origin: { x: 512, y: 0, z: 24 },
        keys: { targetname: "dest" },
      },
    ]);
    expect(doc.brushes[0].shader).toBe("common/trigger");
    const deleted = applyOperations(doc, [{ op: "object.delete", ids: ["tp"] }]);
    expect(deleted.deleted).toEqual(expect.arrayContaining(["tp", "teleporter"]));
  });

  it("dry runs report without changing the input", () => {
    const input: EditorDocumentData = emptyDocument();
    const result = applyOperations(input, [
      { op: "gen.room", id: "r", min: { x: 0, y: 0, z: 0 }, max: { x: 256, y: 256, z: 128 } },
    ]);
    expect(result.created).toHaveLength(7);
    expect(input.brushes).toHaveLength(0);
  });
});

describe("SHAGGED generators", () => {
  it("cuts a doorway into the right pieces without overlaps", () => {
    const room = generateRoom({
      id: "r",
      min: { x: 0, y: 0, z: 0 },
      max: { x: 256, y: 256, z: 128 },
      openings: [{ side: "+X", min: { x: 0, y: 64, z: 0 }, max: { x: 0, y: 192, z: 96 } }],
      light: false,
    });
    const east = room.brushes.filter((b) => b.id.startsWith("r-east"));
    // Strips either side of the door, plus the lintel; no sill at floor level.
    expect(east).toHaveLength(3);
    assertNoOverlaps(room.brushes);
    expect(room.entities).toEqual([]);
  });

  it("keeps openings inside the interior so corners stay sealed", () => {
    expect(() =>
      generateRoom({
        id: "r",
        min: { x: 0, y: 0, z: 0 },
        max: { x: 256, y: 256, z: 128 },
        openings: [{ side: "+X", min: { x: 0, y: -16, z: 0 }, max: { x: 0, y: 64, z: 96 } }],
      }),
    ).toThrow(/inside the interior/);
  });

  it("builds corridors with open ends that stop at their own length", () => {
    const hall = generateCorridor({ id: "h", from: { x: -112, y: 0, z: 0 }, to: { x: 112, y: 0, z: 0 } });
    for (const b of hall.brushes) {
      expect(b.min.x).toBeGreaterThanOrEqual(-112);
      expect(b.max.x).toBeLessThanOrEqual(112);
    }
    expect(hall.brushes.map((b) => b.id).sort()).toEqual(["h-ceiling", "h-floor", "h-north", "h-south"]);
    expect(() => generateCorridor({ id: "h", from: { x: 0, y: 0, z: 0 }, to: { x: 64, y: 64, z: 0 } })).toThrow(
      /exactly one/,
    );
  });
});
