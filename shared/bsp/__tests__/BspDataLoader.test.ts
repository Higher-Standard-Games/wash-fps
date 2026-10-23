import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadBspBuffer } from "../BspDataLoader";

const resolve = vi.hoisted(() => vi.fn());
vi.mock("../../../../../engine/loader/pk3/NodePk3", () => ({ resolveMapBspViaIndex: resolve }));
afterEach(() => vi.resetAllMocks());

it("resolves indexed maps from the process data directories, independent of this module's location", async () => {
  const bytes = new ArrayBuffer(8);
  resolve.mockResolvedValue(bytes);
  await expect(loadBspBuffer("test_map")).resolves.toBe(bytes);
  expect(resolve).toHaveBeenCalledWith([path.resolve("./public/data"), path.resolve("./dist/data")], "test_map");
});
