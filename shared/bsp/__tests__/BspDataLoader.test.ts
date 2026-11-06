import * as path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { extractMapData, extractSpawnPoints, loadBspBuffer } from "../BspDataLoader";

const resolve = vi.hoisted(() => vi.fn());
const disk = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock("node:fs", () => disk);
vi.mock("../../../../../engine/loader/pk3/NodePk3", () => ({ resolveMapBspViaIndex: resolve }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it("resolves indexed maps from the process data directories, independent of this module's location", async () => {
  const bytes = new ArrayBuffer(8);
  resolve.mockResolvedValue(bytes);
  await expect(loadBspBuffer("test_map")).resolves.toBe(bytes);
  expect(resolve).toHaveBeenCalledWith([path.resolve("./public/data"), path.resolve("./dist/data")], "test_map");
});

it("leaves an unindexed map unavailable even when a loose BSP exists", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resolve.mockResolvedValue(null);
  disk.existsSync.mockImplementation((filename) => filename === path.resolve("./public/data/maps/test_map.bsp"));
  disk.readFileSync.mockReturnValue(Buffer.from([1, 2, 3]));

  await expect(loadBspBuffer("test_map")).resolves.toBeNull();
  expect(disk.readFileSync).not.toHaveBeenCalled();
});

it("does not load another BSP after the index rejects a published build", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resolve.mockRejectedValue(new Error("Published map build mismatch: rejected"));
  disk.existsSync.mockImplementation((filename) => filename === path.resolve("./public/data/map_test_map.pk3"));
  const zip = new JSZip();
  zip.file("maps/wrong_map.bsp", Uint8Array.from([4, 5, 6]));
  disk.readFileSync.mockReturnValue(await zip.generateAsync({ type: "nodebuffer" }));

  await expect(loadBspBuffer("test_map")).resolves.toBeNull();
  expect(disk.readFileSync).not.toHaveBeenCalled();
});

it("keeps team-tagged spawn points in bot map knowledge", () => {
  const map = extractMapData([
    { classname: "team_CTF_alphaspawn", properties: { origin: "100 200 16" } },
    { classname: "team_CTF_betaspawn", properties: { origin: "-100 -200 32" } },
  ]);
  expect(map.spawnPoints).toEqual([
    { x: 100, y: 40, z: 200 },
    { x: -100, y: 56, z: -200 },
  ]);
});

it.each(["100  200 16", " 100 200 16 ", "100\t200\t16"])(
  "reads whitespace-separated spawn origins in bot map knowledge: %j",
  (origin) => {
    expect(extractMapData([{ classname: "info_player_deathmatch", properties: { origin } }]).spawnPoints).toEqual([
      { x: 100, y: 40, z: 200 },
    ]);
  },
);

it.each(["nope", "1 2", "1 Infinity 3", "   "])("skips malformed spawn origins: %j", (origin) => {
  expect(
    extractSpawnPoints([
      { classname: "info_player_deathmatch", properties: { origin } },
      { classname: "info_player_start", properties: { origin: "100 200 16" } },
    ]),
  ).toEqual([{ x: 100, y: 40, z: 200 }]);
});

it("preserves the three fallback positions when no usable spawn exists", () => {
  expect(extractSpawnPoints([])).toEqual([
    { x: 0, y: 100, z: 0 },
    { x: 100, y: 100, z: 100 },
    { x: -100, y: 100, z: -100 },
  ]);
});

it("uses the fallback when every spawn origin is malformed", () => {
  expect(extractSpawnPoints([{ classname: "info_player_deathmatch", properties: { origin: "nope" } }])).toEqual(
    extractSpawnPoints([]),
  );
});
