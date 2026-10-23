import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearGameEntityCatalog } from "../../../../../engine/editor/EntityCatalog";
import { registerFpsEditorCatalog } from "../../FpsEditorCatalog";

beforeEach(registerFpsEditorCatalog);
afterEach(clearGameEntityCatalog);

import { type Box, boxesOverlap, subtractBox } from "../../../../../engine/editor/api/BoxCsg";
import { generateStairs } from "../../../../../engine/editor/api/Generators";
import { applyOperations, emptyDocument } from "../../../../../engine/editor/api/Operations";
import type { BoxBrush } from "../../../../../engine/editor/EditorDocument";

const volume = (b: Box) => (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({
  min: { x: x0, y: y0, z: z0 },
  max: { x: x1, y: y1, z: z1 },
});

function assertNoOverlaps(brushes: BoxBrush[]): void {
  for (let i = 0; i < brushes.length; i++)
    for (let j = i + 1; j < brushes.length; j++)
      expect(boxesOverlap(brushes[i], brushes[j]), `${brushes[i].id} overlaps ${brushes[j].id}`).toBe(false);
}

const west = { min: { x: -512, y: -256, z: 0 }, max: { x: -128, y: 256, z: 256 } };
const east = { min: { x: 128, y: -256, z: 0 }, max: { x: 512, y: 256, z: 256 } };

describe("box subtraction", () => {
  it("leaves exactly the volume outside the cut, in non-overlapping pieces", () => {
    const a = box(0, 0, 0, 100, 100, 100);
    const b = box(20, -10, 30, 60, 40, 200);
    const pieces = subtractBox(a, b);
    expect(pieces.reduce((n, p) => n + volume(p), 0)).toBe(volume(a) - 40 * 40 * 70);
    for (const p of pieces) expect(boxesOverlap(p, b)).toBe(false);
    for (let i = 0; i < pieces.length; i++)
      for (let j = i + 1; j < pieces.length; j++) expect(boxesOverlap(pieces[i], pieces[j])).toBe(false);
  });

  it("returns the box unchanged when nothing is cut", () => {
    expect(subtractBox(box(0, 0, 0, 10, 10, 10), box(10, 0, 0, 20, 10, 10))).toEqual([box(0, 0, 0, 10, 10, 10)]);
  });
});

describe("brush.carve", () => {
  it("splits cut brushes, keeping material and brush-entity ownership", () => {
    const { doc } = applyOperations(emptyDocument(), [
      {
        op: "box.create",
        id: "wall",
        min: { x: 0, y: 0, z: 0 },
        max: { x: 16, y: 256, z: 128 },
        shader: "blx/blx_dark",
      },
      { op: "brushEntity.assign", id: "door", classname: "func_door", brushIds: ["wall"] },
    ]);
    const result = applyOperations(doc, [
      { op: "brush.carve", min: { x: -8, y: 64, z: 0 }, max: { x: 24, y: 192, z: 96 } },
    ]);
    const walls = result.doc.brushes;
    expect(walls).toHaveLength(3);
    expect(walls.every((b) => b.shader === "blx/blx_dark")).toBe(true);
    expect(result.doc.brushEntities?.[0].brushIds.sort()).toEqual(walls.map((b) => b.id).sort());
    expect(result.changed).toEqual(["wall"]);
  });
});

describe("gen.connect", () => {
  it("joins two closed rooms with a sealed corridor and no overlapping brushes", () => {
    const { doc, issues } = applyOperations(emptyDocument(), [
      { op: "gen.room", id: "west", ...west },
      { op: "gen.room", id: "east", ...east },
      { op: "gen.connect", id: "hall", from: west, to: east },
    ]);
    // No spawns yet; nothing else to report.
    expect(issues.filter((issue) => issue.code !== "no-spawn")).toEqual([]);
    assertNoOverlaps(doc.brushes);
    const hall = doc.brushes.filter((b) => b.id.startsWith("hall-"));
    expect(hall.map((b) => b.id).sort()).toEqual(["hall-ceiling", "hall-floor", "hall-side-1", "hall-side-2"]);
    // The corridor runs from one interior face to the other.
    for (const b of hall) {
      expect(b.min.x).toBe(-128);
      expect(b.max.x).toBe(128);
    }
    // The doorway is open: nothing occupies the corridor's interior.
    const doorway = box(-200, -64, 0, 200, 64, 128);
    expect(doc.brushes.some((b) => boxesOverlap(b, doorway))).toBe(false);
  });

  it("refuses rooms on different floors and corridors wider than the shared wall", () => {
    expect(() =>
      applyOperations(emptyDocument(), [
        { op: "gen.connect", id: "h", from: west, to: { ...east, min: { ...east.min, z: 64 } } },
      ]),
    ).toThrow(/floors/);
    expect(() =>
      applyOperations(emptyDocument(), [{ op: "gen.connect", id: "h", from: west, to: east, width: 512 }]),
    ).toThrow(/shared y span/);
  });
});

describe("gen.stairs", () => {
  it("climbs to the target in steps no higher than the game's step height", () => {
    const { brushes } = generateStairs({ id: "s", from: { x: 0, y: 0, z: 0 }, to: { x: 256, y: 0, z: 100 } });
    expect(brushes).toHaveLength(7);
    let previous = 0;
    for (const step of brushes) {
      expect(step.max.z - previous).toBeLessThanOrEqual(18);
      previous = step.max.z;
    }
    expect(previous).toBe(100);
    expect(brushes.at(-1)?.max.x).toBe(256);
    expect(() => generateStairs({ id: "s", from: { x: 0, y: 0, z: 0 }, to: { x: 64, y: 0, z: 64 }, step: 24 })).toThrow(
      /at most 18/,
    );
  });
});
