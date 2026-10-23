// @vitest-environment jsdom

import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSession } from "../../../../engine/editor/EditorSession";
import { clearGameEntityCatalog } from "../../../../engine/editor/EntityCatalog";
import { registerFpsEditorCatalog } from "../FpsEditorCatalog";

// The texture drawer's data sources: a fixed two-entry catalog and instant thumbnails.
vi.mock("../../../../engine/editor/TextureCatalogLoader", () => ({
  loadTextureCatalog: async () =>
    ["blx/blx_white_stripe", "boqu/floor"].map((name) => ({
      name,
      folder: name.split("/")[0],
      image: `textures/${name}.tga`,
      hasShader: false,
      tags: [],
      compiler: false,
      sky: false,
      transparent: false,
      nolightmap: false,
      fog: false,
      solidColor: false,
      missing: false,
    })),
}));
vi.mock("../../../../engine/editor/TextureThumbnailsBrowser", () => ({
  createBrowserThumbnails: () => ({
    request: async (path: string) =>
      path.includes("stripe")
        ? { url: "blob:stripe", width: 128, height: 32 }
        : { url: "blob:floor", width: 256, height: 256 },
    cancel: () => {},
    dispose: () => {},
  }),
}));

// The textured preview's image source: every file reads and decodes to a 2×2 image.
vi.mock("../../../../engine/editor/PreviewTextures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../engine/editor/PreviewTextures")>()),
  browserPreviewDeps: async () => ({
    readFile: async () => new ArrayBuffer(4),
    decode: async () => ({ pixels: new Uint8Array(16), width: 2, height: 2 }),
  }),
}));

import { rotateBrush } from "../../../../engine/editor/ConvexBrush";
import { naturalFace } from "../../../../engine/editor/FaceUv";
import { writeMap } from "../../../../engine/editor/MapWriter";
import { createRoomTemplate } from "../../../../engine/editor/RoomTemplate";
import { serverMapName } from "../../../../engine/editor/ServerMapOpen";
import type { ShaggedApi } from "../../../../engine/editor/ShaggedApi";
import { shaderBatches } from "../../../../engine/editor/TexturedPreview";

const context = {
  scale: vi.fn(),
  fillRect: vi.fn(),
  strokeRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  arc: vi.fn(),
  stroke: vi.fn(),
  measureText: vi.fn(() => ({ width: 40 })),
  fillText: vi.fn(),
};
const originalContext = HTMLCanvasElement.prototype.getContext;
const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalCapture = HTMLCanvasElement.prototype.setPointerCapture;

afterEach(() => {
  clearGameEntityCatalog();
  HTMLCanvasElement.prototype.getContext = originalContext;
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  HTMLCanvasElement.prototype.setPointerCapture = originalCapture;
  localStorage.clear();
  document.body.innerHTML = "";
});

beforeEach(() => {
  registerFpsEditorCatalog();
  HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.getBoundingClientRect = (() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  })) as typeof HTMLElement.prototype.getBoundingClientRect;
});

describe("editor DOM shell", () => {
  it("clips and splits from the inspector, rejects invalid planes and subtracts selected cutters with undo", () => {
    const engine = new NullEngine(),
      canvas = document.createElement("canvas");
    document.body.append(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    try {
      session.document.transact((data) => {
        data.brushes = [
          { id: "wall", min: { x: -96, y: 0, z: 0 }, max: { x: 96, y: 32, z: 64 }, shader: "common/caulk" },
          { id: "cutter", min: { x: -16, y: -16, z: -16 }, max: { x: 16, y: 48, z: 80 }, shader: "common/caulk" },
        ];
        data.brushEntities = [{ id: "door", classname: "func_door", keys: {}, brushIds: ["wall"] }];
      });
      session.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
      const pane = session.root.querySelector('[data-plane="xy"]')!;
      const click = (x: number, ctrlKey = false) => {
        for (const type of ["pointerdown", "pointerup"])
          pane.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 134, ctrlKey }));
      };
      click(120);
      const before = session.document.snapshot();
      const clip = session.root.querySelector<HTMLFormElement>("[data-clip-brush]")!;
      clip.querySelector<HTMLInputElement>('[name="normal-x"]')!.value = "0";
      clip.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(session.document.snapshot()).toEqual(before);
      expect(session.root.querySelector(".shagged__status")!.textContent).toContain("nonzero");
      clip.querySelector<HTMLInputElement>('[name="normal-x"]')!.value = "1";
      clip.querySelector<HTMLSelectElement>('[name="keep"]')!.value = "both";
      clip.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(session.document.snapshot().brushEntities![0].brushIds).toEqual(["wall", "wall-2"]);
      expect(session.root.querySelector("[data-selection-move]")).toBeTruthy();
      click(200, true);
      const subtract = session.root.querySelector<HTMLFormElement>("[data-subtract-brush]")!;
      subtract.querySelector<HTMLSelectElement>('[name="cutter"]')!.value = "cutter";
      subtract.querySelector<HTMLInputElement>('[name="remove-cutter"]')!.checked = true;
      const split = session.document.snapshot();
      subtract.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const cut = session.document.snapshot();
      expect(cut.brushes).toHaveLength(2);
      expect(cut.brushes[0].max.x).toBe(-16);
      expect(cut.brushes[1].min.x).toBe(16);
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      expect(session.document.snapshot().brushes).toEqual(split.brushes);
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      expect(session.document.snapshot().brushes).toEqual(before.brushes);
    } finally {
      session.dispose();
      engine.dispose();
    }
  });

  it("marquees, toggles, previews and moves a selection with one undo step", () => {
    const engine = new NullEngine(),
      canvas = document.createElement("canvas");
    document.body.append(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    try {
      session.document.transact((data) => {
        data.brushes = [
          { id: "a", min: { x: -96, y: 0, z: 0 }, max: { x: -64, y: 32, z: 32 }, shader: "common/caulk" },
          { id: "b", min: { x: 32, y: 0, z: 0 }, max: { x: 64, y: 32, z: 32 }, shader: "common/caulk" },
          { id: "c", min: { x: 112, y: 0, z: 0 }, max: { x: 144, y: 32, z: 32 }, shader: "common/caulk" },
        ];
      });
      session.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
      const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
      const pointer = (type: string, x: number, y: number, ctrlKey = false) =>
        xy.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, ctrlKey }));
      const before = session.document.snapshot();
      pointer("pointerdown", 80, 200);
      pointer("pointermove", 280, 100);
      pointer("pointerup", 280, 100);
      expect(session.root.querySelector(".shagged__inspector h2")!.textContent).toContain("2 objects");
      expect(session.document.snapshot()).toEqual(before);
      pointer("pointerdown", 328, 134, true);
      pointer("pointerup", 328, 134, true);
      expect(session.root.querySelector(".shagged__inspector h2")!.textContent).toContain("3 objects");
      pointer("pointerdown", 328, 134, true);
      pointer("pointerup", 328, 134, true);
      pointer("pointerdown", 120, 134);
      pointer("pointermove", 136, 118);
      expect(session.document.snapshot()).toEqual(before);
      expect(session["scene"].getMeshByName("selection-a")).toBeTruthy();
      session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(session.document.snapshot()).toEqual(before);
      expect(session["scene"].getMeshByName("selection-a")).toBeNull();
      pointer("pointerdown", 120, 134);
      pointer("pointermove", 136, 118);
      pointer("pointerup", 136, 118);
      const moved = session.document.snapshot();
      expect(moved.brushes[0].min).toEqual({ x: -80, y: 16, z: 0 });
      expect(moved.brushes[1].min).toEqual({ x: 48, y: 16, z: 0 });
      expect(moved.brushes[2]).toEqual(before.brushes[2]);
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      expect(session.document.snapshot().brushes).toEqual(before.brushes);
    } finally {
      session.dispose();
      engine.dispose();
    }
  });

  it("saves editor groups, selects their members together and duplicates ownership independently", () => {
    const engine = new NullEngine(),
      canvas = document.createElement("canvas");
    document.body.append(canvas);
    let session = new EditorSession(engine, canvas, vi.fn());
    try {
      session.document.transact((data) => {
        data.brushes = [
          { id: "a", min: { x: -96, y: 0, z: 0 }, max: { x: -64, y: 32, z: 32 }, shader: "common/caulk" },
          { id: "b", min: { x: 32, y: 0, z: 0 }, max: { x: 64, y: 32, z: 32 }, shader: "common/caulk" },
        ];
        data.brushEntities = [{ id: "door", classname: "func_door", keys: { speed: "100" }, brushIds: ["a", "b"] }];
      });
      session.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
      const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
      const pointer = (type: string, x: number, y: number, ctrlKey = false) =>
        xy.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, ctrlKey }));
      pointer("pointerdown", 120, 134);
      pointer("pointerup", 120, 134);
      pointer("pointerdown", 248, 134, true);
      pointer("pointerup", 248, 134, true);
      const source = writeMap(session.document.snapshot());
      session.root.querySelector<HTMLInputElement>("[data-group-name]")!.value = "Assembly";
      session.root.querySelector<HTMLButtonElement>("[data-create-group]")!.click();
      expect(writeMap(session.document.snapshot())).toBe(source);
      session.save();
      session.dispose();
      session = new EditorSession(engine, canvas, vi.fn());
      expect(session.root.querySelector(".shagged__inspector h2")!.textContent).toContain("2 objects");
      expect(session.root.querySelector("[data-selection-name]")!.textContent).toBe("Group: Assembly");
      session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
      for (const type of ["pointerdown", "pointerup"])
        pane.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: 120, clientY: 134 }));
      expect(session.root.querySelector(".shagged__inspector h2")!.textContent).toContain("2 objects");
      session.root.querySelector<HTMLButtonElement>('[data-action="vertices"]')!.click();
      expect(session.root.querySelector("[data-vertex-list]")).toBeTruthy();
      session.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
      for (const type of ["pointerdown", "pointerup"])
        pane.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: 248, clientY: 134 }));
      expect(session.root.querySelector(".shagged__inspector h2")!.textContent).toContain("2 objects");
      session.root.querySelector<HTMLButtonElement>('[data-action="duplicate"]')!.click();
      expect(session.document.snapshot().editorGroups).toHaveLength(2);
      expect(session.document.snapshot().brushEntities).toHaveLength(2);
      session.root.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click();
      expect(session.document.snapshot().brushes).toHaveLength(2);
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      expect(session.document.snapshot().brushes).toHaveLength(4);
    } finally {
      session.dispose();
      engine.dispose();
    }
  });

  it("picks convex sides, textures only the selection, aligns and wraps with undo", async () => {
    const engine = new NullEngine(),
      canvas = document.createElement("canvas");
    document.body.append(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    try {
      session.document.transact((data) =>
        data.brushes.push(
          rotateBrush(
            { id: "slab", min: { x: -256, y: -256, z: -16 }, max: { x: 256, y: 256, z: 16 }, shader: "blx/blx_grid" },
            "z",
            15,
          ),
        ),
      );
      session.root.querySelector("[data-grid]")!.dispatchEvent(new Event("change"));
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      session.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.click();
      session.render();
      const click = (modifiers: object) => {
        for (const type of ["pointerdown", "pointerup"])
          canvas.dispatchEvent(
            new MouseEvent(type, { bubbles: true, button: 0, clientX: 200, clientY: 150, ...modifiers }),
          );
      };
      click({ shiftKey: true });
      const net = () =>
        [...session.root.querySelectorAll<HTMLButtonElement>("[data-face-net] button.active")].map(
          (b) => b.dataset.face,
        );
      expect(net()).toEqual(["1"]);
      expect(engine.scenes[0].getMeshByName("shagged-face-1")?.getTotalVertices()).toBe(4);
      expect(session.root.querySelector<HTMLButtonElement>('[data-uv-op="fit"]')!.disabled).toBe(true);
      session.root.querySelector<HTMLButtonElement>('[data-action="textures"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const tile = [...session.root.querySelectorAll<HTMLElement>(".shagged-tex__tile")].find((t) =>
        t.title.startsWith("blx/blx_white_stripe"),
      )!;
      tile.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      let brush = session.document.snapshot().brushes[0];
      expect(brush.hull!.sides[1].material?.shader).toBe("blx/blx_white_stripe");
      expect(brush.hull!.sides.filter((s) => s.material?.sizeKnown !== false)).toHaveLength(1);
      expect(brush.faces).toBeUndefined();
      session.root.querySelector<HTMLButtonElement>('[data-uv-op="fit"]')!.click();
      const fitted = session.document.snapshot().brushes[0].hull!.sides[1].material!;
      session.root.querySelector<HTMLButtonElement>('[data-uv-nudge="shift-u:1"]')!.click();
      expect(session.document.snapshot().brushes[0].hull!.sides[1].material!.shift[0]).toBeCloseTo(fitted.shift[0] + 8);
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      expect(session.document.snapshot().brushes[0].hull!.sides[1].material).toEqual(fitted);
      const field = session.root.querySelector<HTMLInputElement>('[name="scale-u"]')!;
      field.value = "0";
      const before = session.document.snapshot();
      field.dispatchEvent(new Event("change", { bubbles: true }));
      expect(session.document.snapshot()).toEqual(before);
      click({ altKey: true });
      expect(session.root.querySelector("[data-current-texture]")?.textContent).toContain("white_stripe");
      session.root.querySelector<HTMLButtonElement>('[data-face="2"]')!.click();
      tile.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      session.root.querySelector<HTMLButtonElement>('[data-uv-op="wrap"]')!.click();
      brush = session.document.snapshot().brushes[0];
      expect(brush.hull!.sides[1].material).toEqual(fitted);
      expect(brush.hull!.sides[2].material?.shader).toBe(fitted.shader);
      expect(brush.hull!.sides.filter((s) => s.material?.sizeKnown !== false)).toHaveLength(2);
    } finally {
      session.dispose();
      engine.dispose();
    }
  });
  it("drags projected brush vertices as one undoable edit and cancels a drag", () => {
    const engine = new NullEngine(),
      canvas = document.createElement("canvas");
    document.body.append(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    try {
      session.document.transact((data) =>
        data.brushes.push({
          id: "vertexbox",
          min: { x: -64, y: -64, z: 0 },
          max: { x: 64, y: 64, z: 64 },
          shader: "common/caulk",
        }),
      );
      session.root.querySelector<HTMLButtonElement>('[data-action="vertices"]')!.click();
      const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
      const pointer = (type: string, x: number, y: number, shiftKey = false) =>
        pane.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, shiftKey }));
      pointer("pointerdown", 200, 150);
      pointer("pointerup", 200, 150);
      expect(session.root.querySelectorAll("[data-vertex-list] option")).toHaveLength(8);
      const before = session.document.snapshot();
      pointer("pointerdown", 264, 86);
      pointer("pointermove", 280, 86);
      expect(session.document.snapshot()).toEqual(before);
      session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      pointer("pointerup", 280, 86);
      expect(session.document.snapshot()).toEqual(before);
      pointer("pointerdown", 264, 86);
      pointer("pointermove", 280, 86);
      pointer("pointerup", 280, 86);
      const edited = session.document.snapshot();
      expect(edited.brushes[0].max.x).toBe(80);
      expect(edited.brushes[0].hull).toBeDefined();
      expect(edited.revision).toBe(before.revision + 1);
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      expect(session.document.snapshot().brushes[0].hull).toBeUndefined();
      session.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.click();
      expect(session.document.snapshot().brushes[0].max.x).toBe(80);
    } finally {
      session.dispose();
      engine.dispose();
    }
  });
  it("edits an individual vertex numerically, toggles projected groups and rejects collapse", () => {
    const engine = new NullEngine(),
      canvas = document.createElement("canvas");
    document.body.append(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    try {
      session.document.transact((data) =>
        data.brushes.push({
          id: "vertexbox",
          min: { x: -64, y: -64, z: 0 },
          max: { x: 64, y: 64, z: 64 },
          shader: "common/caulk",
        }),
      );
      session.root.querySelector<HTMLButtonElement>('[data-action="vertices"]')!.click();
      const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
      pane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
      const select = (indices: number[]) => {
        const list = session.root.querySelector<HTMLSelectElement>("[data-vertex-list]")!;
        for (const option of list.options) option.selected = indices.includes(Number(option.value));
        list.dispatchEvent(new Event("change"));
      };
      select([6]);
      const set = (axis: string, value: string) => {
        session.root.querySelector<HTMLInputElement>(`[name="vertex-${axis}"]`)!.value = value;
      };
      set("x", "80");
      set("y", "80");
      set("z", "80");
      session.root
        .querySelector<HTMLFormElement>("[data-vertex-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(session.document.snapshot().brushes[0].max.z).toBe(80);
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      select([4, 5, 6, 7]);
      set("z", "-64");
      const before = session.document.snapshot();
      session.root
        .querySelector<HTMLFormElement>("[data-vertex-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(session.document.snapshot()).toEqual(before);
      expect(session.root.textContent).toContain("Vertex edit rejected");
      pane.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 136, clientY: 214, shiftKey: true }),
      );
      const selected = [...session.root.querySelector<HTMLSelectElement>("[data-vertex-list]")!.selectedOptions].map(
        (o) => Number(o.value),
      );
      expect(selected).toEqual([0, 4, 5, 6, 7]);
      session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      expect(session.document.snapshot().brushes).toHaveLength(1);
    } finally {
      session.dispose();
      engine.dispose();
    }
  });
  it("rotates from the inspector, keeps the hull through bounds edits and restores a box with undo", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    try {
      session.document.transact((data) =>
        data.brushes.push({
          id: "shape",
          min: { x: -64, y: -16, z: 0 },
          max: { x: 64, y: 16, z: 16 },
          shader: "blx/blx_grid",
        }),
      );
      session.root.querySelector<HTMLSelectElement>("[data-grid]")!.dispatchEvent(new Event("change"));
      session.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
      const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
      pane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
      pane.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
      session.root.querySelector<HTMLButtonElement>("[data-rotate-brush]")!.click();
      expect(session.document.snapshot().brushes[0].hull?.sides.length).toBe(6);
      expect(session.root.querySelector<HTMLFormElement>("[data-brush-form]")!.checkValidity()).toBe(true);
      expect(session.root.querySelector("[data-face-net]")?.textContent).toContain("Side 0");
      const height = session.root.querySelector<HTMLInputElement>('[name="max-z"]')!;
      height.value = "48";
      session.root
        .querySelector<HTMLFormElement>("[data-brush-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(session.document.snapshot().brushes[0].max.z).toBe(48);
      expect(session.document.snapshot().brushes[0].hull).toBeDefined();
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
      expect(session.document.snapshot().brushes[0].hull).toBeUndefined();
    } finally {
      session.dispose();
      engine.dispose();
    }
  });
  it("groups toolbar actions and keeps menu actions usable", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    expect(
      [...session.root.querySelectorAll(".shagged__toolgroup")].map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Map actions", "Edit actions", "Placement tools", "View actions", "Build actions"]);
    const menu = session.root.querySelector<HTMLDetailsElement>(".shagged__toolgroup .shagged__menu")!;
    expect(session.root.querySelector(".shagged__toolbar strong")?.textContent).toBe("SHAGGED");
    expect(menu.querySelector("[data-map-title]")?.textContent).toBe("Untitled");
    expect(menu.querySelector('[data-action="save"]')).toBeTruthy();
    expect(session.root.querySelectorAll("[data-draft-name]")).toHaveLength(1);
    menu.open = true;
    menu.querySelector<HTMLButtonElement>('[data-action="room"]')!.click();
    expect(menu.open).toBe(false);
    expect(session.document.snapshot().brushes.length).toBeGreaterThan(0);
    expect(menu.querySelector("[data-map-title]")?.textContent).toBe("Room Template");
    const name = menu.querySelector<HTMLInputElement>("[data-draft-name]")!;
    name.value = "Practice room";
    name.dispatchEvent(new Event("change"));
    expect(menu.querySelector("[data-map-title]")?.textContent).toBe("Practice room");
    menu.open = true;
    menu.querySelector("summary")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.open).toBe(false);
    expect(session.root.querySelector('[data-action="compile-status"]')?.textContent).toContain("Status:");
    session.dispose();
    engine.dispose();
  });

  it("opens a server map and keeps divergent local work when opening a server copy", async () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const sidecar = createRoomTemplate();
    const name = serverMapName(sidecar.draftId);
    const map = { name, revision: 4, sourceHash: "hash", source: writeMap(sidecar), sidecar };
    const api = {
      status: vi.fn(async () => ({
        saveAvailable: true,
        compilerAvailable: false,
        playableAvailable: false,
        supportedQualities: [],
        reason: "Compiler unavailable",
      })),
      maps: vi.fn(async () => [{ name, revision: 4, sourceHash: "hash" }]),
      map: vi.fn(async () => map),
    } as unknown as ShaggedApi;
    const session = new EditorSession(engine, canvas, vi.fn(), api);
    await vi.waitFor(() =>
      expect(session.root.querySelector<HTMLButtonElement>('[data-action="server-maps"]')?.disabled).toBe(false),
    );
    session.root.querySelector<HTMLButtonElement>('[data-action="server-maps"]')!.click();
    await vi.waitFor(() => expect(session.root.querySelector(`[data-map-name="${name}"]`)).toBeTruthy());
    session.root.querySelector<HTMLButtonElement>(`[data-map-name="${name}"]`)!.click();
    await vi.waitFor(() => expect(session.draftId).toBe(sidecar.draftId));
    expect(JSON.parse(localStorage.getItem(`shagged:view:v1:${sidecar.draftId}`)!)).toMatchObject({
      serverSave: { revision: 4 },
    });
    session.document.transact((data) => {
      data.brushes[0].max.x += 16;
    });
    session.save();
    const localMax = session.document.snapshot().brushes[0].max.x;
    session.root.querySelector<HTMLButtonElement>('[data-action="server-maps"]')!.click();
    await vi.waitFor(() => expect(session.root.querySelector(`[data-map-name="${name}"]`)).toBeTruthy());
    session.root.querySelector<HTMLButtonElement>(`[data-action="open-server-map"]`)!.click();
    await vi.waitFor(() => expect(session.root.querySelector("[data-server-conflict]")).toBeTruthy());
    expect(session.document.snapshot().brushes[0].max.x).toBe(localMax);
    session.root.querySelector<HTMLButtonElement>('[data-action="server-copy"]')!.click();
    await vi.waitFor(() => expect(session.draftId).not.toBe(sidecar.draftId));
    expect(session.document.snapshot().brushes[0].max.x).toBe(sidecar.brushes[0].max.x);
    expect(JSON.parse(localStorage.getItem(`shagged:draft:v1:${sidecar.draftId}`)!).brushes[0].max.x).toBe(localMax);
    session.dispose();
    engine.dispose();
  });
  it("saves a revision before compiling and keeps a stale server revision from being overwritten", async () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    let serverRevision = 0;
    const savedSources: string[] = [];
    const api = {
      status: vi.fn(async () => ({
        saveAvailable: true,
        compilerAvailable: true,
        playableAvailable: false,
        supportedQualities: ["default"],
        reason: null,
      })),
      save: vi.fn(async (_name: string, source: string, expectedRevision: number) => {
        if (expectedRevision !== serverRevision) throw new Error("Map revision conflict");
        savedSources.push(source);
        return { revision: ++serverRevision };
      }),
      mapRevision: vi.fn(async () => serverRevision),
      compile: vi.fn(async () => ({ jobId: "job-1" })),
      job: vi.fn(async () => ({
        id: "job-1",
        mapName: "test",
        revision: serverRevision,
        state: "compiled",
        stage: "complete",
        logs: ["Build complete"],
        runtimeMapName: null,
      })),
    } as unknown as ShaggedApi;
    const session = new EditorSession(engine, canvas, vi.fn(), api);
    await vi.waitFor(() =>
      expect(session.root.querySelector<HTMLButtonElement>('[data-action="server-save"]')?.disabled).toBe(false),
    );
    session.root.querySelector<HTMLButtonElement>('[data-action="room"]')!.click();
    const mapId = session.root.querySelector<HTMLInputElement>("[data-map-id]")!;
    mapId.value = "whatevermap";
    mapId.dispatchEvent(new Event("change"));
    session.root.querySelector<HTMLButtonElement>('[data-action="compile"]')!.click();
    await vi.waitFor(() => expect(api.compile).toHaveBeenCalledWith("whatevermap", 1));
    expect(mapId.disabled).toBe(true);
    await vi.waitFor(() =>
      expect(session.root.querySelector('[data-action="compile-status"]')?.textContent).toContain("compiled"),
    );
    expect(savedSources).toHaveLength(1);
    expect(savedSources[0]).toContain('"classname" "worldspawn"');
    expect(JSON.parse(localStorage.getItem(`shagged:view:v1:${session.draftId}`)!)).toMatchObject({
      serverSave: { revision: 1, documentRevision: session.revision },
    });
    session.document.transact((data) => {
      data.entities[0].origin.x += 16;
    });
    serverRevision = 2;
    session.root.querySelector<HTMLButtonElement>('[data-action="server-save"]')!.click();
    await vi.waitFor(() =>
      expect(session.root.querySelector(".shagged__status")?.textContent).toContain("Server map is at revision 2"),
    );
    expect(savedSources).toHaveLength(1);
    session.dispose();
    engine.dispose();
  });
  it("creates a room from the toolbar and recovers its draft and view", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const first = new EditorSession(engine, canvas, vi.fn());
    // the flycam drives the camera; Babylon's own inputs stay detached so left click remains selection
    const camera = engine.scenes[0].activeCamera as FreeCamera;
    expect(camera.getClassName()).toBe("FreeCamera");
    expect(camera.inputs.attachedToElement).toBe(false);
    first.root.querySelector<HTMLButtonElement>('[data-action="room"]')!.click();
    expect(first.document.snapshot().brushes).toHaveLength(6);
    expect(first.document.snapshot().entities.find((e) => e.classname === "info_player_deathmatch")?.origin.z).toBe(48);
    first.render();
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
    canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
    expect(first.root.querySelector("[data-brush-form]")).toBeTruthy();
    const id = first.draftId;
    expect(
      localStorage.getItem("shagged:active-draft:v1"),
      first.root.querySelector(".shagged__status")?.textContent,
    ).toBe(id);
    first.dispose();
    const restored = new EditorSession(engine, canvas, vi.fn());
    expect(restored.draftId).toBe(id);
    expect(restored.document.snapshot().brushes).toHaveLength(6);
    restored.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
    // World (100, 0): on the floor, clear of the spawn and light at the room's centre.
    restored.root
      .querySelector<HTMLCanvasElement>('[data-plane="xy"]')!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 300, clientY: 150 }));
    const form = restored.root.querySelector<HTMLFormElement>("[data-brush-form]")!;
    expect(form).toBeTruthy();
    const selectedId = restored.root.querySelector("[data-brush-id]")!.textContent!;
    const original = restored.document.snapshot().brushes.find((brush) => brush.id.startsWith(selectedId))!;
    form.querySelector<HTMLInputElement>('[name="max-z"]')!.value = String(original.max.z + 16);
    form.querySelector<HTMLInputElement>('[name="shader"]')!.value = "blx/blx_dark";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const edited = restored.document.snapshot().brushes.find((brush) => brush.id === original.id)!;
    expect(edited.max.z).toBe(original.max.z + 16);
    expect(edited.shader).toBe("blx/blx_dark");
    restored.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    expect(restored.document.snapshot().brushes.find((brush) => brush.id === original.id)).toEqual(original);

    restored.root.querySelector<HTMLButtonElement>('[data-action="new"]')!.click();
    restored.root.querySelector<HTMLButtonElement>('[data-action="brush"]')!.click();
    const work = restored.root.querySelector<HTMLInputElement>("[data-workplane]")!;
    work.value = "128";
    work.dispatchEvent(new Event("change"));
    const xy = restored.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    context.strokeRect.mockClear();
    xy.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
    xy.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 264, clientY: 86 }));
    expect(restored.document.snapshot().brushes).toHaveLength(0);
    // the "min 1 grid cell" warning at pointerdown (start === current, no preview yet), then the preview
    // box and the live dimension label's border once pointermove gives it a real size
    expect(context.strokeRect).toHaveBeenCalledTimes(5);
    const ghost = engine.scenes[0].getMeshByName("shagged-gesture-preview");
    expect(ghost?.position.y).toBe(136);
    xy.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 264, clientY: 86 }));
    expect(restored.document.snapshot().brushes[0].min.z).toBe(128);
    expect(restored.document.snapshot().brushes[0].max.z).toBe(144);
    expect(engine.scenes[0].getMeshByName("shagged-gesture-preview")).toBeNull();
    const newId = restored.draftId;
    const name = restored.root.querySelector<HTMLInputElement>("[data-draft-name]")!;
    name.value = "Practice room";
    name.dispatchEvent(new Event("change"));
    restored.root.querySelector<HTMLButtonElement>('[data-action="drafts"]')!.click();
    const chooser = restored.root.querySelector<HTMLDetailsElement>(".shagged__menu--file")!;
    expect(chooser.open).toBe(true);
    restored.root.querySelector<HTMLButtonElement>(`[data-draft-id="${id}"]`)!.click();
    expect(restored.draftId).toBe(id);
    expect(restored.document.snapshot().brushes).toHaveLength(6);
    expect(name.value).toBe("Room Template");
    expect(work.value).toBe("0");
    expect(chooser.open).toBe(false);
    restored.root.querySelector<HTMLButtonElement>('[data-action="drafts"]')!.click();
    restored.root.querySelector<HTMLButtonElement>(`[data-draft-id="${newId}"]`)!.click();
    expect(restored.draftId).toBe(newId);
    expect(restored.document.snapshot().brushes[0].min.z).toBe(128);
    expect(name.value).toBe("Practice room");
    expect(work.value).toBe("128");
    restored.dispose();
    engine.dispose();
  });

  it("pans, draws at the new center, frames, and restores navigation without changing map history", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    let session = new EditorSession(engine, canvas, vi.fn());
    const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string, x: number, y: number, button = 0) =>
      pane.dispatchEvent(new MouseEvent(type, { bubbles: true, button, clientX: x, clientY: y }));
    pointer("pointerdown", 200, 150, 1);
    pointer("pointermove", 264, 182, 1);
    pointer("pointerup", 264, 182, 1);
    expect(session.document.canUndo).toBe(false);
    pointer("pointerdown", 200, 150);
    pointer("pointerup", 264, 86);
    expect(session.document.snapshot().brushes[0]).toMatchObject({
      min: { x: -64, y: 32, z: 0 },
      max: { x: 0, y: 96, z: 16 },
    });
    const data = session.document.snapshot();
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    // framing keeps the look direction and puts the bounds' centre (Quake -32, 64, 8) on the view axis
    const camera = engine.scenes[0].activeCamera as FreeCamera;
    const toCenter = new Vector3(-32, 8, 64).subtract(camera.position).normalize();
    camera.getViewMatrix(true);
    const forward = camera.getDirection(Vector3.Forward()).normalize();
    expect(Vector3.Distance(toCenter, forward)).toBeLessThan(1e-6);
    expect(session.document.snapshot()).toEqual(data);
    const saved = JSON.parse(localStorage.getItem(`shagged:view:v1:${session.draftId}`)!);
    expect(saved.viewCenter).toEqual({ x: -32, y: 64, z: 8 });
    const id = session.draftId;
    session.dispose();
    session = new EditorSession(engine, canvas, vi.fn());
    session.save();
    expect(JSON.parse(localStorage.getItem(`shagged:view:v1:${id}`)!)).toMatchObject({
      viewCenter: saved.viewCenter,
      zoom: saved.zoom,
      camera: saved.camera,
    });
    expect(saved.camera).toMatchObject({ yaw: expect.any(Number), pitch: expect.any(Number) });
    session.dispose();
    engine.dispose();
  });

  it("places, moves, edits, duplicates and deletes a point entity", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string, x: number, y: number) =>
      xy.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    const entities = () => session.document.snapshot().entities;

    // Pick a light in the toolbar, then click world (64, 32) in the top view.
    const picker = session.root.querySelector<HTMLSelectElement>("[data-entity-class]")!;
    expect([...picker.querySelectorAll("optgroup")].map((group) => group.label)).toContain("LIGHTS");
    picker.value = "light";
    picker.dispatchEvent(new Event("change"));
    expect(session.root.querySelector('[data-action="entity"]')!.classList.contains("active")).toBe(true);
    pointer("pointerdown", 264, 118);
    pointer("pointerup", 264, 118);
    // The light's box (-16..32 on Z) stands on the work plane at Z=0.
    expect(entities()).toMatchObject([{ classname: "light", origin: { x: 64, y: 32, z: 16 }, keys: {} }]);
    const id = entities()[0].id;
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("1 entities");

    // Select and drag it 32 units along +X.
    session.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
    pointer("pointerdown", 264, 118);
    pointer("pointermove", 296, 118);
    expect(entities()[0].origin.x).toBe(64); // a preview, not yet a document change
    pointer("pointerup", 296, 118);
    expect(entities()[0].origin).toEqual({ x: 96, y: 32, z: 16 });

    // The inspector lists documented keys, keeps an unknown one, and adds a new one.
    session.document.transact((data) => {
      data.entities[0].keys._mod_flag = "<b>kept</b>";
    });
    session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    session.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.click();
    const form = session.root.querySelector<HTMLFormElement>("[data-entity-form]")!;
    const unknown = form.querySelector<HTMLInputElement>('[name="key:_mod_flag"]')!;
    expect(unknown.value).toBe("<b>kept</b>"); // a value, never parsed as markup
    expect(form.querySelector("b")).toBeNull();
    expect(form.querySelector<HTMLInputElement>('[name="key:light"]')!.placeholder).toBe("300");
    form.querySelector<HTMLInputElement>('[name="key:light"]')!.value = "450";
    form.querySelector<HTMLInputElement>('[name="new-key"]')!.value = "targetname";
    form.querySelector<HTMLInputElement>('[name="new-value"]')!.value = "lamp1";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(entities()[0].keys).toEqual({ light: "450", targetname: "lamp1", _mod_flag: "<b>kept</b>" });

    // A value a .map can't hold is refused without changing the entity.
    const again = session.root.querySelector<HTMLFormElement>("[data-entity-form]")!;
    again.querySelector<HTMLInputElement>('[name="key:light"]')!.value = 'say "hi"';
    again.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(entities()[0].keys.light).toBe("450");
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("Entity edit rejected");

    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true }));
    expect(entities()).toHaveLength(2);
    expect(entities()[1]).toMatchObject({ classname: "light", origin: { x: 112, y: 32, z: 16 } });
    expect(entities()[1].keys).toEqual(entities()[0].keys);

    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(entities().map((entity) => entity.id)).toEqual([id]);
    session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    expect(entities()).toHaveLength(2);
    session.dispose();
    engine.dispose();
  });

  it("places a model prop, edits compiler keys, and reports an incomplete reference", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const picker = session.root.querySelector<HTMLSelectElement>("[data-entity-class]")!;
    picker.value = "misc_model";
    picker.dispatchEvent(new Event("change"));
    const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string) =>
      xy.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: 264, clientY: 118 }));
    pointer("pointerdown");
    pointer("pointerup");
    expect(session.document.snapshot().entities[0]).toMatchObject({
      classname: "misc_model",
      origin: { x: 64, y: 32, z: 0 },
      keys: { model: "", modelscale: "1" },
    });
    expect(session.root.querySelector(".shagged__warning")!.textContent).toContain("models/...");
    const form = session.root.querySelector<HTMLFormElement>("[data-entity-form]")!;
    expect(form.querySelector<HTMLInputElement>('[name="key:model"]')!.getAttribute("list")).toBe(
      "shagged-model-paths",
    );
    form.querySelector<HTMLInputElement>('[name="key:model"]')!.value = "models/mapobjects/crate/crate.md3";
    form.querySelector<HTMLInputElement>('[name="key:angle"]')!.value = "90";
    form.querySelector<HTMLInputElement>('[name="key:modelscale"]')!.value = "2";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(writeMap(session.document.snapshot())).toContain('"modelscale" "2"');
    expect(session.root.querySelector(".shagged__warning")!.textContent).toContain("MakeBSP decides");
    session.dispose();
    engine.dispose();
  });

  it("drops a model picked from the browser on its base, and swaps the model of a selected prop", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const bounds = { min: { x: -16, y: -16, z: -8 }, max: { x: 16, y: 16, z: 24 } };
    session["pickModel"]("models/props/crate.glb", bounds);
    expect(session.root.querySelector<HTMLSelectElement>("[data-entity-class]")!.value).toBe("misc_model");
    expect(session.root.querySelector("[data-entity-short]")!.textContent).toBe("model");
    expect(session.root.querySelector('[data-action="entity"]')!.classList.contains("active")).toBe(true);
    const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    xy.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 264, clientY: 118 }));
    xy.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 264, clientY: 118 }));
    expect(session.document.snapshot().entities[0]).toMatchObject({
      classname: "misc_model",
      origin: { x: 64, y: 32, z: 8 },
      keys: { model: "models/props/crate.glb", modelscale: "1" },
    });
    session["pickModel"]("models/objects/misc/barrel.md3", null);
    expect(session.document.snapshot().entities).toHaveLength(1);
    expect(session.document.snapshot().entities[0].keys.model).toBe("models/objects/misc/barrel.md3");
    session.document.undo();
    expect(session.document.snapshot().entities[0].keys.model).toBe("models/props/crate.glb");
    session.dispose();
    engine.dispose();
  });

  it("turns a brush into a trigger, warns about its required key, grows a door, and prunes on delete", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string, x: number, y: number) =>
      xy.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    const data = () => session.document.snapshot();
    const submit = () =>
      session.root
        .querySelector<HTMLFormElement>("[data-brush-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const owner = () => session.root.querySelector<HTMLSelectElement>('[name="owner"]')!;

    // Draw a brush, then make it a new trigger_teleport from the inspector.
    pointer("pointerdown", 200, 150);
    pointer("pointerup", 264, 86);
    const brushId = data().brushes[0].id;
    expect(owner().value).toBe("world");
    owner().value = "new:trigger_teleport";
    submit();
    expect(data().brushEntities).toMatchObject([{ classname: "trigger_teleport", keys: {}, brushIds: [brushId] }]);
    expect(data().brushes[0].shader).toBe("common/trigger");
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("1 entities");

    // The game drops a teleporter without target; the inspector says so until it is set.
    const warning = session.root.querySelector<HTMLElement>("[data-missing]")!;
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toContain("target");
    expect(session.root.querySelector('[name="key:model"]')).toBeNull();
    session.root.querySelector<HTMLInputElement>('[name="key:target"]')!.value = "dest1";
    submit();
    expect(data().brushEntities![0].keys).toEqual({ target: "dest1" });
    expect(session.root.querySelector<HTMLElement>("[data-missing]")!.hidden).toBe(true);
    expect(writeMap(data())).toContain('"classname" "trigger_teleport"\n"target" "dest1"\n{\nbrushDef');

    // Back to worldspawn: the emptied entity disappears, the trigger texture stays.
    owner().value = "world";
    submit();
    expect(data().brushEntities).toEqual([]);

    // A door: one brush becomes func_door, a duplicate joins it, deleting one keeps the other.
    owner().value = "new:func_door";
    submit();
    expect(data().brushes[0].shader).toBe("common/trigger"); // movers keep the brush's own shader
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true }));
    expect(data().brushes).toHaveLength(2);
    expect(data().brushEntities![0].brushIds).toHaveLength(2);
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(data().brushEntities![0].brushIds).toEqual([brushId]);

    // Deleting the last brush removes the entity with it.
    session.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
    pointer("pointerdown", 232, 118);
    pointer("pointerup", 232, 118);
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(data().brushes).toHaveLength(0);
    expect(data().brushEntities).toEqual([]);
    session.dispose();
    engine.dispose();
  });

  it("applies a texture from the browser to the selected brush and to brushes drawn after", async () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string, x: number, y: number) =>
      xy.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.root.querySelector("[data-current-texture]")!.textContent).toBe("common/caulk");

    pointer("pointerdown", 200, 150);
    pointer("pointerup", 264, 86);
    const first = session.document.snapshot().brushes[0];
    expect(first.faces).toBeUndefined(); // drawn before any pick: fixed legacy alignment

    const open = new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true });
    session.root.dispatchEvent(open);
    // the shortcut focuses the drawer's search box, so its own "t" must not be typed there
    expect(open.defaultPrevented).toBe(true);
    await flush();
    await flush();
    const drawer = session.root.querySelector<HTMLElement>(".shagged-tex")!;
    expect(drawer.hidden).toBe(false);
    // typing "t" to search from the grid neither closes the drawer nor reaches other shortcuts
    drawer
      .querySelector(".shagged-tex__grid")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    expect(drawer.hidden).toBe(false);
    const stripe = [...drawer.querySelectorAll<HTMLElement>(".shagged-tex__tile")].find((tile) =>
      tile.title.startsWith("blx/blx_white_stripe"),
    )!;
    stripe.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await flush();

    const painted = session.document.snapshot().brushes[0];
    expect(painted.shader).toBe("blx/blx_white_stripe");
    expect(Object.keys(painted.faces!).sort()).toEqual(["+X", "+Y", "+Z", "-X", "-Y", "-Z"]);
    expect(painted.faces!["+Z"]).toEqual({
      shader: "blx/blx_white_stripe",
      shift: [0, 0],
      scale: [0.5, 0.5],
      rotation: 0,
      size: [128, 32],
    });
    // 128×32 at 0.5 units per texel: 1/64 across, 1/16 down
    expect(writeMap(session.document.snapshot())).toContain("( ( 0.015625 0 0 ) ( 0 0.0625 0 ) ) blx/blx_white_stripe");
    expect(session.root.querySelector("[data-current-texture]")!.textContent).toBe("blx/blx_white_stripe");
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain(
      "Applied blx/blx_white_stripe (128×32)",
    );
    session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    expect(session.document.snapshot().brushes[0].shader).toBe("common/caulk"); // one undo step

    // A brush drawn now gets the current texture with natural alignment.
    drawer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer.hidden).toBe(true);
    pointer("pointerdown", 200, 214);
    pointer("pointerup", 264, 182);
    const drawn = session.document.snapshot().brushes.at(-1)!;
    expect(drawn.shader).toBe("blx/blx_white_stripe");
    expect(drawn.faces!["-X"]?.size).toEqual([128, 32]);
    session.dispose();
    expect(session.root.querySelector(".shagged-tex")).toBeNull();
    engine.dispose();
  });

  it("picks faces in 3D and from the face net, textures just those faces, and samples a face", async () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    // A wide, flat slab under the default camera: a ray through the view centre hits its top face.
    session.document.transact((data) =>
      data.brushes.push({
        id: "slab",
        min: { x: -256, y: -256, z: -16 },
        max: { x: 256, y: 256, z: 16 },
        shader: "blx/blx_grid",
      }),
    );
    // Undo then redo goes through the editor's own change path, which rebuilds the 3D meshes;
    // a grid change first redraws, which enables the Undo button.
    session.root.querySelector("[data-grid]")!.dispatchEvent(new Event("change"));
    session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    session.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.click();
    session.render();
    const click = (modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => {
      for (const type of ["pointerdown", "pointerup"]) {
        canvas.dispatchEvent(
          new MouseEvent(type, { bubbles: true, button: 0, clientX: 200, clientY: 150, ...modifiers }),
        );
      }
    };
    const status = () => session.root.querySelector(".shagged__status")!.textContent!;
    const net = () =>
      [...session.root.querySelectorAll<HTMLButtonElement>("[data-face-net] button")]
        .filter((b) => b.classList.contains("active"))
        .map((b) => b.dataset.face);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    click({ shiftKey: true });
    expect(status()).toContain("Faces +Z selected");
    expect(net()).toEqual(["+Z"]);
    expect(engine.scenes[0].getMeshByName("shagged-face-+Z")).not.toBeNull();
    click({ ctrlKey: true, shiftKey: true }); // old chord remains usable
    expect(net()).toEqual([]);
    click({ shiftKey: true });
    expect(net()).toEqual(["+Z"]);
    // the face net reaches faces the camera can't see
    session.root.querySelector<HTMLButtonElement>('[data-face-net] button[data-face="-X"]')!.click();
    expect(net().sort()).toEqual(["+Z", "-X"].sort());

    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    await flush();
    await flush();
    const stripe = [...session.root.querySelectorAll<HTMLElement>(".shagged-tex__tile")].find((tile) =>
      tile.title.startsWith("blx/blx_white_stripe"),
    )!;
    stripe.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await flush();
    const slab = session.document.snapshot().brushes[0];
    expect(slab.shader).toBe("blx/blx_grid"); // only the picked faces change
    expect(Object.keys(slab.faces!).sort()).toEqual(["+Z", "-X"].sort());
    expect(slab.faces!["+Z"]).toMatchObject({ shader: "blx/blx_white_stripe", size: [128, 32], scale: [0.5, 0.5] });
    expect(status()).toContain("to 2 faces");

    // A face that already has an alignment keeps it when only its texture changes.
    session.document.transact((data) => {
      data.brushes[0].faces!["+Z"]!.rotation = 45;
    });
    const floor = [...session.root.querySelectorAll<HTMLElement>(".shagged-tex__tile")].find((tile) =>
      tile.title.startsWith("boqu/floor"),
    )!;
    floor.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await flush();
    expect(session.document.snapshot().brushes[0].faces!["+Z"]).toMatchObject({
      shader: "boqu/floor",
      rotation: 45,
      size: [256, 256],
    });

    // Alt+click samples the face's texture as the current texture, without touching the selection.
    click({ altKey: true });
    expect(session.root.querySelector("[data-current-texture]")!.textContent).toBe("boqu/floor");
    expect(status()).toContain("Sampled boqu/floor from face +Z");
    expect(net().sort()).toEqual(["+Z", "-X"].sort());

    // A plain click selects the brush and clears the faces.
    click();
    expect(net()).toEqual([]);
    expect(engine.scenes[0].getMeshByName("shagged-face-+Z")).toBeNull();
    session.dispose();
    engine.dispose();
  });

  it("aligns the selected faces from the inspector panel as one undo step, and wraps a texture around", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    session.document.transact((data) =>
      data.brushes.push({
        id: "slab",
        min: { x: -256, y: -256, z: -16 },
        max: { x: 256, y: 256, z: 16 },
        shader: "blx/blx_grid",
        faces: { "+Z": naturalFace("boqu/floor", [256, 256]), "+X": naturalFace("blx/blx_white_stripe", [128, 32]) },
      }),
    );
    session.root.querySelector("[data-grid]")!.dispatchEvent(new Event("change"));
    session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    session.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.click();
    session.render();
    for (const type of ["pointerdown", "pointerup"]) {
      canvas.dispatchEvent(
        new MouseEvent(type, { bubbles: true, button: 0, clientX: 200, clientY: 150, ctrlKey: true, shiftKey: true }),
      );
    }
    session.root.querySelector<HTMLButtonElement>('[data-face-net] button[data-face="+X"]')!.click();
    const faces = () => session.document.snapshot().brushes[0].faces!;
    const status = () => session.root.querySelector(".shagged__status")!.textContent!;
    const panel = (selector: string) =>
      session.root.querySelector<HTMLButtonElement>(`[data-face-alignment] ${selector}`)!;

    panel('[data-uv-nudge="shift-u:1"]').click();
    expect(faces()["+Z"]!.shift).toEqual([8, 0]);
    expect(faces()["+X"]!.shift).toEqual([8, 0]);
    expect(status()).toContain("Shift U +8 on 2 faces");
    session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    expect(faces()["+Z"]!.shift).toEqual([0, 0]);
    expect(faces()["+X"]!.shift).toEqual([0, 0]);

    // the panel survives undo with the faces still selected, and wraps from the first one picked
    expect(panel('[data-uv-op="wrap"]').textContent).toBe("Wrap from +Z");
    panel('[data-uv-op="wrap"]').click();
    expect(faces()["+X"]).toMatchObject({ shader: "boqu/floor", size: [256, 256] });
    expect(faces()["+Z"]).toEqual(naturalFace("boqu/floor", [256, 256]));

    // a face still on the brush's fixed alignment locks the panel
    session.root.querySelector<HTMLButtonElement>('[data-face-net] button[data-face="-Y"]')!.click();
    expect(panel('[data-uv-op="fit"]').disabled).toBe(true);
    expect(session.root.querySelector("[data-face-alignment]")!.textContent).toContain(
      "Face -Y has no known image size",
    );
    session.dispose();
    engine.dispose();
  });

  it("opens textured, with UVs that are the faces' ST, and switches to Brush and Wireframe", async () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const rotated = {
      ...naturalFace("boqu/floor", [256, 256] as [number, number]),
      rotation: 30,
      shift: [5, 9] as [number, number],
    };
    session.document.transact((data) =>
      data.brushes.push({
        id: "slab",
        min: { x: -256, y: -256, z: -16 },
        max: { x: 256, y: 256, z: 16 },
        shader: "blx/blx_grid",
        faces: { "+Z": rotated },
      }),
    );
    session.document.transact((data) =>
      data.entities.push({
        id: "spawn",
        classname: "info_player_deathmatch",
        origin: { x: 200, y: 200, z: 64 },
        keys: {},
      }),
    );
    session.root.querySelector("[data-grid]")!.dispatchEvent(new Event("change"));
    session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    session.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.click();
    const scene = engine.scenes[0];
    const mode = (name: string) => session.root.querySelector<HTMLButtonElement>(`[data-view-mode="${name}"]`)!;
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    // Textured is the default; the catalog loads in the background
    expect(mode("textured").classList.contains("active")).toBe(true);
    expect(mode("textured").getAttribute("aria-pressed")).toBe("true");
    for (let i = 0; i < 4; i++) await flush();
    const floor = scene.getMeshByName("shagged-textured-boqu/floor")!;
    const grid = scene.getMeshByName("shagged-textured-blx/blx_grid")!;
    const expected = shaderBatches(session.document.snapshot().brushes);
    const uvs = (mesh: typeof floor) => [...(mesh.getVerticesData("uv") ?? [])];
    expect(uvs(floor)).toEqual(expected[0].uvs);
    expect(uvs(grid)).toHaveLength(5 * 4 * 2);
    expect(floor.isPickable).toBe(false);
    // the brush box stays as the pick and selection layer, see-through until selected
    expect(scene.getMeshByName("slab")!.material!.alpha).toBe(0);

    // picking still works through the textured faces
    for (const type of ["pointerdown", "pointerup"]) {
      canvas.dispatchEvent(
        new MouseEvent(type, { bubbles: true, button: 0, clientX: 200, clientY: 150, ctrlKey: true, shiftKey: true }),
      );
    }
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("Faces +Z selected");
    // the picked face's own overlay marks it, light enough to see its texture
    expect(scene.getMeshByName("slab")!.material!.alpha).toBe(0);
    expect(scene.getMeshByName("shagged-face-+Z")!.material!.alpha).toBe(0.18);

    mode("brush").click();
    expect(mode("brush").classList.contains("active")).toBe(true);
    expect(mode("textured").classList.contains("active")).toBe(false);
    expect(scene.getMeshByName("shagged-textured-boqu/floor")).toBeNull();
    expect(scene.getMeshByName("slab")!.material!.alpha).toBe(0.82);
    // switching with a face selected restyles its overlay too
    expect(scene.getMeshByName("shagged-face-+Z")!.material!.alpha).toBe(0.6);

    // Wireframe: no faces, only the brush edges as lines, in the selection colour for the selected brush
    mode("wireframe").click();
    expect(scene.getMeshByName("slab")!.isVisible).toBe(false);
    expect(scene.getMeshByName("spawn")!.isVisible).toBe(true); // entities keep their boxes
    const wire = scene.getMeshByName("shagged-wireframe")!;
    expect(wire.getTotalVertices()).toBe(12 * 2);
    expect(wire.getVerticesData("color")!.slice(0, 4)).toEqual([1, 0.75, 0.2, 1]);
    expect(scene.getMeshByName("shagged-textured-boqu/floor")).toBeNull();
    // the invisible box still takes the pick: a right click clears, a left click selects again
    const fire = (type: string, button: number) =>
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, button, clientX: 200, clientY: 150 }));
    fire("pointerdown", 2);
    fire("pointerup", 2);
    expect(session.root.querySelector("[data-brush-id]")).toBeNull();
    fire("pointerdown", 0);
    fire("pointerup", 0);
    expect(session.root.querySelector("[data-brush-id]")!.textContent).toBe("slab");
    // the mode is part of the saved view
    expect(JSON.parse(localStorage.getItem(`shagged:view:v1:${session.draftId}`)!).viewMode).toBe("wireframe");

    mode("textured").click();
    expect(scene.getMeshByName("shagged-textured-boqu/floor")).not.toBeNull();
    session.dispose();
    engine.dispose();
  });

  it("deselects with a right click or Escape, pans with a right drag, and selects or moves with the Brush tool", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string, x: number, y: number, button = 0) =>
      pane.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: x, clientY: y }));
    const click = (x: number, y: number, button = 0) => {
      pointer("pointerdown", x, y, button);
      pointer("pointerup", x, y, button);
    };
    const selected = () => session.root.querySelector("[data-brush-id]")?.textContent ?? null;
    const status = () => session.root.querySelector(".shagged__status")!.textContent!;

    // draw a brush with the Brush tool: it becomes the selection
    pointer("pointerdown", 200, 150);
    pointer("pointerup", 264, 86);
    const drawn = session.document.snapshot().brushes[0];
    expect(selected()).toBe(drawn.id.slice(0, 8));

    // a right click deselects, in an orthographic pane
    click(230, 120, 2);
    expect(selected()).toBeNull();
    expect(status()).toContain("Selection cleared");

    // a Brush-tool click on a brush selects it rather than drawing
    click(230, 120);
    expect(selected()).toBe(drawn.id.slice(0, 8));
    expect(session.document.snapshot().brushes).toHaveLength(1);

    // dragging the selected brush with the Brush tool moves it instead of drawing a new one
    pointer("pointerdown", 230, 120);
    pointer("pointermove", 262, 120);
    pointer("pointerup", 262, 120);
    expect(session.document.snapshot().brushes).toHaveLength(1);
    expect(session.document.snapshot().brushes[0].min.x).toBe(drawn.min.x + 32);

    // a Brush-tool click on empty space clears the selection ("focus out")
    click(20, 20);
    expect(selected()).toBeNull();
    expect(session.document.snapshot().brushes).toHaveLength(1);

    // a right drag pans without deselecting or editing
    click(262, 120);
    const before = session.document.snapshot();
    pointer("pointerdown", 100, 100, 2);
    pointer("pointermove", 164, 100, 2);
    pointer("pointerup", 164, 100, 2);
    expect(selected()).not.toBeNull();
    expect(session.document.snapshot()).toEqual(before);
    const saved = JSON.parse(localStorage.getItem(`shagged:view:v1:${session.draftId}`)!);
    expect(saved.viewCenter.x).toBeLessThan(0);

    // Escape with nothing else open deselects
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(selected()).toBeNull();

    // the context menu never opens over a pane
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    pane.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    session.dispose();
    engine.dispose();
  });

  it("deselects with a right click in 3D and loads a view saved with the orbit camera", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    let session = new EditorSession(engine, canvas, vi.fn());
    session.root.querySelector<HTMLButtonElement>('[data-action="room"]')!.click();
    const id = session.draftId;
    const fire = (type: string, button: number) =>
      canvas.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: 200, clientY: 150 }),
      );
    fire("pointerdown", 0);
    fire("pointerup", 0);
    expect(session.root.querySelector("[data-brush-id]")).not.toBeNull();
    fire("pointerdown", 2);
    fire("pointerup", 2);
    expect(session.root.querySelector("[data-brush-id]")).toBeNull();
    session.dispose();

    // a view saved before the flycam: the orbit's eye and look direction carry over
    const key = `shagged:view:v1:${id}`;
    const view = JSON.parse(localStorage.getItem(key)!);
    view.camera = { alpha: Math.PI / 2, beta: Math.PI / 2, radius: 500, target: { x: 0, y: 0, z: 64 } };
    localStorage.setItem(key, JSON.stringify(view));
    session = new EditorSession(engine, canvas, vi.fn());
    const camera = engine.scenes.at(-1)!.activeCamera as FreeCamera;
    // Babylon alpha π/2, beta π/2 puts the eye on Babylon +Z (Quake +Y), level with the target
    expect(camera.position.x).toBeCloseTo(0, 6);
    expect(camera.position.y).toBeCloseTo(64, 6);
    expect(camera.position.z).toBeCloseTo(500, 6);
    session.save();
    const migrated = JSON.parse(localStorage.getItem(key)!).camera;
    expect(migrated.yaw).toBeCloseTo(270, 9);
    expect(migrated.pitch).toBeCloseTo(0, 9);
    session.dispose();
    engine.dispose();
  });

  it("warns when a resize or draw hits the one-grid-unit floor, instead of silently refusing to go smaller", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string, x: number, y: number) =>
      xy.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    const lastLabel = () => context.fillText.mock.calls.at(-1)![0] as string;

    pointer("pointerdown", 200, 150);
    pointer("pointerup", 264, 86); // brush x spans -64..0 on screen 200..264

    // a small, still-valid resize: no floor warning
    pointer("pointerdown", 203, 118); // the left (min.x) edge
    context.fillText.mockClear();
    pointer("pointermove", 210, 118);
    expect(lastLabel()).not.toContain("(min)");
    // dragging the same edge far past the opposite face: resizeBox clamps it, and the label says so
    pointer("pointermove", 400, 118);
    expect(lastLabel()).toContain("(min)");
    pointer("pointerup", 400, 118);
    // the brush itself never actually inverted or vanished
    const clampedBrush = session.document.snapshot().brushes[0];
    expect(clampedBrush.max.x - clampedBrush.min.x).toBeGreaterThanOrEqual(16);

    // typing a size smaller than one grid unit shows the same warning, and commits the clamped size, not the typo.
    // The clamp above left the brush only 16 wide (-16..0); its untouched right edge is still at screen 264.
    pointer("pointerdown", 261, 118);
    pointer("pointermove", 255, 118);
    context.fillText.mockClear();
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(lastLabel()).toContain("(min)");
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("below the one-grid-unit floor");
    const afterTyped = session.document.snapshot().brushes[0];
    expect(afterTyped.max.x - afterTyped.min.x).toBe(16); // the floor, not "1"

    // drawing less than one grid cell: no box exists yet, but the cursor still explains why
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    context.fillText.mockClear();
    pointer("pointerdown", 400, 300);
    pointer("pointermove", 402, 300); // well under a grid cell at this zoom
    expect(lastLabel()).toBe("min 1 grid cell");
    pointer("pointerup", 402, 300);
    expect(session.document.snapshot().brushes).toHaveLength(1); // still just the one brush: nothing new was drawn
    session.dispose();
    engine.dispose();
  });

  it("types an exact size while resizing a single edge: digits, Backspace, Escape clears the buffer not the drag, Enter commits", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string, x: number, y: number) =>
      xy.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    const key = (value: string) =>
      session.root.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));

    // draw a brush, then grab its left (x) edge
    pointer("pointerdown", 200, 150);
    pointer("pointerup", 264, 86);
    const before = session.document.snapshot().brushes[0];
    pointer("pointerdown", 203, 118);
    pointer("pointermove", 190, 118); // a live mouse-driven resize is in progress

    key("1");
    key("0");
    key("0");
    key("5"); // a typo
    expect(session.root.querySelector(".shagged__status")!.textContent).not.toContain("Set X"); // not yet
    key("Backspace"); // "1005" -> "100"
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    session.root.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);

    const resized = session.document.snapshot().brushes[0];
    expect(resized.max.x - resized.min.x).toBe(100); // exact, not whatever the mouse happened to be at
    expect(resized.max.x).toBe(before.max.x); // the un-dragged face stays anchored
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("Set X to exactly 100");

    // the gesture ended with the Enter commit: a further mouse move does nothing more
    pointer("pointermove", 50, 118);
    pointer("pointerup", 50, 118);
    expect(session.document.snapshot().brushes[0]).toEqual(resized);

    // Escape while typing clears only the buffer, keeping the drag (and the un-committed numbers) alive.
    // The left edge moved to resized.min.x on screen; the right edge (never touched) is still at 264.
    pointer("pointerdown", 264, 118); // grab the untouched right edge
    pointer("pointermove", 300, 118);
    key("5");
    const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    session.root.dispatchEvent(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);
    pointer("pointerup", 300, 118); // the ordinary mouse-driven resize still finishes normally
    const afterEscape = session.document.snapshot().brushes[0];
    expect(afterEscape.max.x - afterEscape.min.x).not.toBe(5); // "5" never committed
    expect(afterEscape.max.x - afterEscape.min.x).toBeGreaterThan(100); // the mouse drag did widen it

    // typing during a draw (two axes, no single edge) does nothing
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    pointer("pointerdown", 400, 300);
    pointer("pointermove", 450, 350);
    key("9");
    pointer("pointerup", 450, 350);
    expect(session.document.snapshot().brushes.some((b) => b.max.x - b.min.x === 9)).toBe(false);
    session.dispose();
    engine.dispose();
  });

  it("shows a live width × depth × height label at the cursor while drawing or resizing, in the dragged pane only", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const xy = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const xz = session.root.querySelector<HTMLCanvasElement>('[data-plane="xz"]')!;
    const pointer = (pane: HTMLCanvasElement, type: string, x: number, y: number) =>
      pane.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));

    context.fillText.mockClear();
    pointer(xy, "pointerdown", 200, 150);
    pointer(xy, "pointermove", 264, 86);
    // the span used elsewhere in this file for (200,150)->(264,86): 64 wide (x), 64 deep (y), 16 tall (z)
    expect(context.fillText).toHaveBeenLastCalledWith("64 × 64 × 16", expect.any(Number), expect.any(Number));
    // only the pane actually being dragged gets a label
    expect(context.fillText.mock.calls.filter((call) => call[0] === "64 × 64 × 16")).toHaveLength(1);
    pointer(xy, "pointerup", 264, 86);

    // resizing shows the same live label
    pointer(xy, "pointerdown", 203, 118); // near the just-drawn brush's left edge: grabs that edge
    context.fillText.mockClear();
    pointer(xy, "pointermove", 180, 118); // drag it out
    expect(context.fillText).toHaveBeenCalled();
    pointer(xy, "pointerup", 180, 118);

    // a move (not draw/resize) doesn't show a size label — the size isn't changing
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    context.fillText.mockClear();
    pointer(xy, "pointerdown", 232, 118);
    pointer(xy, "pointermove", 260, 118);
    expect(context.fillText).not.toHaveBeenCalled();
    pointer(xy, "pointerup", 260, 118);

    context.fillText.mockClear();
    pointer(xz, "pointermove", 10, 10); // hovering an idle pane: no label anywhere
    expect(context.fillText).not.toHaveBeenCalled();
    session.dispose();
    engine.dispose();
  });

  it("outlines the 3D pane and shows the Escape hint while free look is active", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const pane = session.root.querySelector<HTMLElement>(".shagged__pane--perspective")!;
    const fire = (type: string, button: number) =>
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, button, clientX: 200, clientY: 150 }));
    expect(pane.classList.contains("shagged__pane--freelook")).toBe(false);

    fire("pointerdown", 1); // a middle click toggles free look
    fire("pointerup", 1);
    expect(pane.classList.contains("shagged__pane--freelook")).toBe(true);
    expect(pane.querySelector(".shagged__free-look-hint")?.textContent).toContain("Press ESC to release mouse");

    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pane.classList.contains("shagged__pane--freelook")).toBe(false);

    fire("pointerdown", 1);
    fire("pointerup", 1);
    expect(pane.classList.contains("shagged__pane--freelook")).toBe(true);
    fire("pointerdown", 1);
    fire("pointerup", 1);
    expect(pane.classList.contains("shagged__pane--freelook")).toBe(false);
    session.dispose();
    engine.dispose();
  });

  it("shows a resize cursor on a draggable edge, a hand where a press moves, and a closed hand while moving", async () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const pointer = (type: string, x: number, y: number, button = 0) =>
      pane.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: x, clientY: y }));
    const hover = (x: number, y: number) => {
      pointer("pointermove", x, y);
      return pane.style.cursor;
    };
    // a brush spanning screen x 200..264 and y 86..150, selected after drawing
    pointer("pointerdown", 200, 150);
    pointer("pointerup", 264, 86);

    expect(hover(232, 118)).toBe("grab");
    expect(hover(203, 118)).toBe("ew-resize"); // near its left edge
    expect(hover(232, 147)).toBe("ns-resize"); // near its bottom edge
    expect(hover(203, 89)).toBe("nwse-resize"); // near its top-left corner: both axes at once
    expect(hover(20, 20)).toBe(""); // empty space: the tool's crosshair

    // dragging a corner resizes both axes in one gesture
    const before = session.document.snapshot().brushes[0];
    pointer("pointerdown", 203, 89);
    pointer("pointermove", 180, 70);
    pointer("pointerup", 180, 70);
    const after = session.document.snapshot().brushes[0];
    expect(after.min.x).toBeLessThan(before.min.x);
    expect(after.max.y).toBeGreaterThan(before.max.y);
    expect(after.max.x).toBe(before.max.x);
    expect(after.min.y).toBe(before.min.y);

    // the Brush tool only grabs the selection; elsewhere a drag draws
    pointer("pointerdown", 20, 20, 2);
    pointer("pointerup", 20, 20, 2);
    expect(hover(232, 118)).toBe("");
    // the Select tool grabs whatever is there
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    expect(hover(232, 118)).toBe("grab");

    pointer("pointerdown", 232, 118);
    expect(pane.style.cursor).toBe("grabbing");
    pointer("pointermove", 264, 118);
    pointer("pointerup", 264, 118);
    await Promise.resolve();
    expect(pane.style.cursor).toBe("grab"); // still over the moved brush

    // a pan shows the closed hand too
    pointer("pointerdown", 20, 20, 1);
    expect(pane.style.cursor).toBe("grabbing");
    pointer("pointerup", 20, 20, 1);
    expect(pane.style.cursor).toBe("");
    session.dispose();
    engine.dispose();
  });

  it("opens the Map Health tray (toolbar or H) and selects what a row points to", async () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    session.document.transact((data) => {
      data.brushes.push(
        { id: "box", min: { x: 0, y: 0, z: 0 }, max: { x: 64, y: 64, z: 64 }, shader: "blx/blx_grid" },
        { id: "far", min: { x: 500, y: 500, z: 0 }, max: { x: 564, y: 564, z: 64 }, shader: "blx/blx_grid" },
      );
      data.entities.push({
        id: "pad",
        classname: "bogus_class_xyz",
        origin: { x: 100, y: 100, z: 0 },
        keys: {},
      });
      data.brushEntities = [{ id: "trigger-1", classname: "trigger_teleport", keys: {}, brushIds: ["far"] }];
      data.patches = [
        {
          id: "arch",
          shader: "not/in/catalog",
          width: 3,
          height: 3,
          controlPoints: Array.from({ length: 3 }, (_, row) =>
            Array.from({ length: 3 }, (_, col) => ({ x: col * 32, y: row * 32, z: 0, u: col / 2, v: row / 2 })),
          ),
        },
      ];
    });
    const tray = () => session.root.querySelector<HTMLElement>(".shagged-health")!;
    const rows = () => [...tray().querySelectorAll<HTMLButtonElement>(".shagged-health__row")];
    const selected = () =>
      session.root.querySelector("[data-brush-id], [data-entity-id], [data-patch-id]")?.textContent ?? null;
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    session.root.querySelector<HTMLButtonElement>('[data-action="health"]')!.click();
    expect(tray().hidden).toBe(false);
    expect(rows().length).toBeGreaterThan(0);
    expect(tray().textContent).toContain("needs");

    // a brush-entity issue selects one of its owned brushes, since the entity itself has no box
    const linkRow = rows().find((row) => row.textContent?.includes("needs"))!;
    linkRow.click();
    expect(selected()).toContain("far".slice(0, 8));

    // a point-entity issue selects the entity directly
    tray().querySelector<HTMLButtonElement>(".shagged-health__refresh")!.click();
    const classRow = rows().find((row) => row.textContent?.includes("Unlisted point class"))!;
    classRow.click();
    expect(selected()).toContain("bogus_class_xyz");

    // a patch issue selects the patch directly, once the catalog has loaded for the shader check
    await flush();
    await flush();
    tray().querySelector<HTMLButtonElement>(".shagged-health__refresh")!.click();
    const patchRow = rows().find((row) => row.textContent?.includes("not/in/catalog"))!;
    patchRow.click();
    expect(selected()).toContain("arch");

    // H re-opens; typing "h" with a text input focused must not trigger it
    tray().querySelector<HTMLButtonElement>(".shagged-health__close")!.click();
    expect(tray().hidden).toBe(true);
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    expect(tray().hidden).toBe(false);
    session.dispose();
    engine.dispose();
  });

  it("selects a brush that lies between coarse grid lines", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    session.document.transact((data) =>
      data.brushes.push({
        id: "narrow",
        min: { x: 16, y: 16, z: 0 },
        max: { x: 48, y: 48, z: 16 },
        shader: "blx/blx_grid",
      }),
    );
    session.root.querySelector<HTMLSelectElement>("[data-grid]")!.value = "64";
    session.root.querySelector("[data-grid]")!.dispatchEvent(new Event("change"));
    session.root.querySelector<HTMLButtonElement>('[data-action="select"]')!.click();
    const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    // Pane centre is (200, 150) at zoom 1, so world (32, 32) is client (232, 118).
    pane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 232, clientY: 118 }));
    pane.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 232, clientY: 118 }));
    expect(session.root.querySelector("[data-brush-id]")?.textContent).toBe("narrow");
    session.dispose();
    engine.dispose();
  });

  it("keeps an event's status message and an unsaved inspector edit across a redraw", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const status = () => session.root.querySelector(".shagged__status")!.textContent!;
    // A one-cell-thin drag is rejected with a message; the redraw after it must not erase it.
    pane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
    pane.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 264, clientY: 150 }));
    expect(status()).toContain("Drag at least one grid cell");

    pane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
    pane.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 264, clientY: 86 }));
    const maxX = session.root.querySelector<HTMLInputElement>('[name="max-x"]')!;
    maxX.value = "512";
    pane.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1, clientX: 200, clientY: 150 }),
    );
    expect(session.root.querySelector<HTMLInputElement>('[name="max-x"]')!.value).toBe("512");
    session.dispose();
    engine.dispose();
  });

  it("shows the hovered Quake coordinate in the status bar, and clears it on pointerleave", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    const status = () => session.root.querySelector(".shagged__status")!.textContent!;

    expect(status()).not.toContain("cursor");
    pane.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 232, clientY: 118 }));
    expect(status()).toContain("cursor (32, 32, 0)");

    // A hover during an active drag doesn't overwrite it with stale coordinates.
    pane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
    pane.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 264, clientY: 86 }));
    expect(status()).not.toContain("cursor");
    pane.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 264, clientY: 86 }));

    pane.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 232, clientY: 118 }));
    expect(status()).toContain("cursor (32, 32, 0)");
    pane.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    expect(status()).not.toContain("cursor");

    session.dispose();
    engine.dispose();
  });

  it("steps grid size with [ and ], cancels a drag with Escape, then closes the drafts popover", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const grid = session.root.querySelector<HTMLSelectElement>("[data-grid]")!;
    const key = (k: string) => session.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

    expect(grid.value).toBe("16");
    key("[");
    expect(grid.value).toBe("8");
    key("[");
    expect(grid.value).toBe("8"); // already the smallest option
    key("]");
    key("]");
    expect(grid.value).toBe("32");

    const pane = session.root.querySelector<HTMLCanvasElement>('[data-plane="xy"]')!;
    pane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 150 }));
    pane.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 264, clientY: 86 }));
    expect(engine.scenes[0].getMeshByName("shagged-gesture-preview")).not.toBeNull();
    key("Escape");
    expect(engine.scenes[0].getMeshByName("shagged-gesture-preview")).toBeNull();
    pane.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 264, clientY: 86 }));
    expect(session.document.snapshot().brushes).toHaveLength(0); // the cancelled drag committed nothing

    session.root.querySelector<HTMLButtonElement>('[data-action="drafts"]')!.click();
    const drafts = session.root.querySelector<HTMLDetailsElement>(".shagged__menu--file")!;
    expect(drafts.open).toBe(true);
    key("Escape");
    expect(drafts.open).toBe(false);

    session.dispose();
    engine.dispose();
  });

  it("separates Save (Ctrl+S) from Export (Ctrl+Shift+S)", () => {
    vi.useFakeTimers();
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    // jsdom has no Blob URL implementation at all, so these are defined fresh
    // rather than spied on, and removed afterward instead of restored.
    const createObjectURL = vi.fn().mockReturnValue("blob:shagged-test");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("saved locally");

    session.root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    // Export frees its Blob URL a second later. Let that happen now, while the
    // stub still exists, not during whichever test file runs a second from now.
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:shagged-test");
    vi.useRealTimers();

    // Removed rather than restored: jsdom never had these, this test added them.
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    anchorClick.mockRestore();
    session.dispose();
    engine.dispose();
  });
});

describe("the drawing tools", () => {
  it("groups Select, Vertices, Brush, Patch and Curves with their letter keys", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const group = session.root.querySelector<HTMLElement>('[aria-label="Drawing tools"]')!;
    expect(
      [...group.querySelectorAll("button[data-action], summary")].slice(0, 5).map((key) => key.textContent),
    ).toEqual(["Select", "Vertices", "Brush", "Patch", "Curves"]);
    expect([...group.querySelectorAll(":scope > button > b, summary > b")].map((key) => key.textContent)).toEqual([
      "S",
      "V",
      "B",
      "P",
      "C",
    ]);
    const press = (key: string) => session.root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    const active = () => group.querySelector(":scope > button.active")?.getAttribute("data-action");
    for (const [key, tool] of [
      ["b", "brush"],
      ["s", "select"],
      ["v", "vertices"],
      ["p", "patch"],
      ["s", "select"],
      ["g", "vertices"],
    ]) {
      press(key);
      expect(active()).toBe(tool);
    }
    expect(session.root.querySelector('[data-action="entity"]')!.textContent).toBe("Entityspawn");
    const hud = (part: string) => session.root.querySelector(`[data-hud-${part}]`)!.textContent;
    expect(hud("tool")).toBe("VVertices");
    press("e");
    expect(hud("tool")).toBe("EEntity info_player_deathmatch");
    expect(session.root.querySelector("[data-current-texture]")!.textContent).toBe("common/caulk");
    expect(hud("grid")).toBe("grid 16");
    const curves = group.querySelector<HTMLDetailsElement>(".shagged__menu--curves")!;
    press("c");
    expect(curves.open).toBe(true);
    session.dispose();
    engine.dispose();
  });
});

describe("the Caulk key", () => {
  it("caulks the selected brushes in one undo step, or arms a caulk brush with nothing selected", () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    session.root.querySelector<HTMLButtonElement>('[data-action="room"]')!.click();
    const caulkKey = session.root.querySelector<HTMLButtonElement>(
      '[aria-label="Drawing tools"] [data-action="caulk"]',
    )!;
    const [first, second, third] = session.document.snapshot().brushes;
    session["selectObject"](first.id, false);
    session["selectObject"](second.id, true);
    caulkKey.click();
    const shaders = () => session.document.snapshot().brushes.map((brush) => brush.shader);
    expect(shaders().slice(0, 3)).toEqual(["common/caulk", "common/caulk", third.shader]);
    expect(session.document.snapshot().brushes[0].faces).toBeUndefined();
    session.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click();
    expect(shaders().slice(0, 2)).toEqual([first.shader, second.shader]);

    session["selectObject"](null, false);
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    caulkKey.click();
    expect(session.root.querySelector('[aria-label="Drawing tools"] button.active')?.getAttribute("data-action")).toBe(
      "brush",
    );
    expect(session.root.querySelector("[data-current-texture]")!.textContent).toBe("common/caulk");
    expect(shaders().slice(0, 2)).toEqual([first.shader, second.shader]);
    session.dispose();
    engine.dispose();
  });
});

describe("the File panel", () => {
  function blobUrls() {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:shagged-test";
    });
    URL.revokeObjectURL = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    return {
      blobs,
      restore() {
        delete (URL as { createObjectURL?: unknown }).createObjectURL;
        delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
        anchorClick.mockRestore();
      },
    };
  }

  function mapFile(name: string, source: string): File {
    return new File([source], name, { type: "text/plain" });
  }

  it("lists local drafts with download for every row and delete for all but the open one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const urls = blobUrls();
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    const untitled = session.draftId;
    session.save();
    session.root.querySelector<HTMLButtonElement>('[data-action="room"]')!.click();
    session.root.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true }));
    const menu = session.root.querySelector<HTMLDetailsElement>(".shagged__menu--file")!;
    expect(menu.open).toBe(true);
    session.root.querySelector<HTMLButtonElement>('[data-action="drafts"]')!.click();
    const rows = () => [...session.root.querySelectorAll<HTMLElement>("[data-file-list] .shagged__file-row")];
    expect(rows()).toHaveLength(2);
    expect(rows()[0].classList.contains("is-current")).toBe(true);
    expect(rows()[0].querySelector("[data-delete-draft]")).toBeNull();
    expect(session.root.querySelector("[data-file-count=local]")?.textContent).toBe("2");

    session.root.querySelector<HTMLButtonElement>(`[data-download-draft="${untitled}"]`)!.click();
    expect(urls.blobs).toHaveLength(1);
    expect(await urls.blobs[0].text()).toContain('"classname" "worldspawn"');
    expect(menu.open).toBe(true); // downloading keeps the panel open

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    session.root.querySelector<HTMLButtonElement>(`[data-delete-draft="${untitled}"]`)!.click();
    expect(rows()).toHaveLength(2);
    session.root.querySelector<HTMLButtonElement>(`[data-delete-draft="${untitled}"]`)!.click();
    expect(rows()).toHaveLength(1);
    expect(localStorage.getItem(`shagged:draft:v1:${untitled}`)).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    confirm.mockRestore();
    urls.restore();
    session.dispose();
    engine.dispose();
  });

  it("imports a chosen or dropped .map as a new draft and keeps the open one", async () => {
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const session = new EditorSession(engine, canvas, vi.fn());
    session.root.querySelector<HTMLButtonElement>('[data-action="room"]')!.click();
    const before = session.draftId;
    const template = session.document.snapshot();
    const input = session.root.querySelector<HTMLInputElement>("[data-import-file]")!;
    Object.defineProperty(input, "files", { configurable: true, value: [mapFile("dm_test.map", writeMap(template))] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(session.draftId).not.toBe(before));
    expect(session.document.snapshot().brushes).toHaveLength(template.brushes.length);
    expect(session.root.querySelector<HTMLInputElement>("[data-draft-name]")!.value).toBe("imported: dm_test");
    expect(localStorage.getItem(`shagged:draft:v1:${before}`)).not.toBeNull();
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("Imported dm_test.map");

    const drop = (files: File[]) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
      session.root.dispatchEvent(event);
      return event;
    };
    expect(drop([mapFile("notes.txt", "hello")]).defaultPrevented).toBe(true);
    expect(session.root.querySelector(".shagged__status")!.textContent).toContain("Only .map files");
    const imported = session.draftId;
    drop([mapFile("q3dm17.map", writeMap(template))]);
    await vi.waitFor(() => expect(session.draftId).not.toBe(imported));
    expect(session.root.querySelector<HTMLInputElement>("[data-draft-name]")!.value).toBe("imported: q3dm17");
    session.dispose();
    engine.dispose();
  });

  it("downloads a server map's .map without opening it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const urls = blobUrls();
    const engine = new NullEngine();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const sidecar = createRoomTemplate();
    const name = serverMapName(sidecar.draftId);
    const api = {
      status: vi.fn(async () => ({
        saveAvailable: true,
        compilerAvailable: false,
        playableAvailable: false,
        supportedQualities: [],
        reason: null,
      })),
      maps: vi.fn(async () => [{ name, revision: 2, sourceHash: "hash" }]),
      map: vi.fn(async () => ({ name, revision: 2, sourceHash: "hash", source: "// the server copy", sidecar })),
    } as unknown as ShaggedApi;
    const session = new EditorSession(engine, canvas, vi.fn(), api);
    const draft = session.draftId;
    await vi.waitFor(() =>
      expect(session.root.querySelector<HTMLButtonElement>('[data-action="server-maps"]')?.disabled).toBe(false),
    );
    session.root.querySelector<HTMLButtonElement>('[data-action="server-maps"]')!.click();
    await vi.waitFor(() => expect(session.root.querySelector(`[data-download-server="${name}"]`)).toBeTruthy());
    session.root.querySelector<HTMLButtonElement>(`[data-download-server="${name}"]`)!.click();
    await vi.waitFor(() => expect(urls.blobs).toHaveLength(1));
    expect(await urls.blobs[0].text()).toBe("// the server copy");
    expect(session.draftId).toBe(draft);
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    urls.restore();
    session.dispose();
    engine.dispose();
  });
});
