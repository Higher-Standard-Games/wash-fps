import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotClient } from "../BotClient";
import { DIFFICULTY_PRESETS } from "../BotConfig";
import { initialBotReference, modelDigest } from "../BotRatingIdentity";

let dir: string | undefined;
afterEach(() => {
  if (!dir) return;
  const target = path.resolve(dir);
  if (
    !target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
    !path.basename(target).startsWith("shag-bot-identity-")
  )
    throw new Error("Unsafe test cleanup");
  fs.rmSync(target, { recursive: true, force: true });
  dir = undefined;
});
describe("runtime bot identities", () => {
  it("ignores names and fresh process ids and records the effective fallback preset", () => {
    const first = new BotClient({ name: "One", difficulty: "medium", goalArbiter: "on" });
    const second = new BotClient({ name: "Two", difficulty: "missing-preset", goalArbiter: "on" });
    expect(first.id).not.toBe(second.id);
    expect(first.ratingReference).toEqual(second.ratingReference);
    expect(first.ratingReference.preset).toBe("medium");
    expect(initialBotReference({ name: "Unknown", difficulty: "toString", goalArbiter: "on" })).toEqual(
      first.ratingReference,
    );
  });
  it("tracks custom difficulty by value without retaining mutable caller data", () => {
    const difficulty = { ...DIFFICULTY_PRESETS.hard };
    const bot = new BotClient({ name: "Custom", difficulty });
    difficulty.aimAccuracy = 0;
    expect(bot.ratingReference).toMatchObject({ preset: "custom", difficulty: { aimAccuracy: 0.75 } });
    const changes: unknown[] = [];
    bot.on("ratingReferenceChanged", (value) => changes.push(value));
    bot.setDifficulty("easy");
    expect(changes).toEqual([bot.ratingReference]);
    expect(bot.ratingReference.preset).toBe("easy");
    const copy = bot.ratingReference;
    copy.difficulty.aimAccuracy = 1;
    expect(bot.ratingReference.difficulty.aimAccuracy).toBe(0.25);
  });
  it("hashes model contents independently of directory location and notices replaced shards", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-bot-identity-"));
    for (const name of ["first", "renamed"]) {
      const head = path.join(dir, name, "combat");
      fs.mkdirSync(head, { recursive: true });
      fs.writeFileSync(path.join(head, "model.json"), "{}");
      fs.writeFileSync(path.join(head, "weights.bin"), new Uint8Array([1, 2, 3]));
    }
    const original = modelDigest(path.join(dir, "first"));
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(modelDigest(path.join(dir, "renamed"))).toBe(original);
    fs.writeFileSync(path.join(dir, "renamed", "combat", "weights.bin"), new Uint8Array([3, 2, 1]));
    expect(modelDigest(path.join(dir, "renamed"))).not.toBe(original);
    expect(modelDigest(path.join(dir, "missing"))).toBeNull();
    expect(
      initialBotReference({ name: "Model", difficulty: "medium", modelDir: path.join(dir, "first") }).model.status,
    ).toBe("loading");
  });
});
