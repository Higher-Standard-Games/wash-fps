/** Rebuildable, immutable local benchmark fixtures; never modifies existing matches. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { BOT_SECRET_HEADER, loadBotSecret, resolveDataDir } from "../../../lobby/ServerData";
import {
  isFixtureId,
  selectTimedemoTarget,
  type TimedemoFixture,
  type TimedemoSegment,
  validateTimedemoFixture,
} from "../../../shared/benchmark/TimedemoFixture";
import { type DemoFrame, DemoReader } from "../../../shared/demo/DemoReader";
import { MatchPhase } from "../../../shared/server/gametype/index";
import { BotServer } from "../bot/BotServer";
import { isClientKey } from "../ClientEntityKey";
import { GameServer } from "../server/GameServer";
import { Deathmatch } from "../server/gametypes/Deathmatch";
import { loadBspCollision } from "./HeadlessMapLoader";

const args = process.argv.slice(2).filter((v) => v !== "--");
const option = (name: string, fallback?: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const cancellation = new AbortController();
process.on("SIGINT", () => cancellation.abort());
process.on("SIGTERM", () => cancellation.abort());
process.on("message", (message) => {
  if (message === "cancel") cancellation.abort();
});
const wait = (ms: number) =>
  new Promise<void>((resolve, reject) => {
    const signal = cancellation.signal;
    const done = () => {
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(new Error("Fixture recording cancelled"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });

async function record(
  recipe: { map: string; bots: number; difficulty: string; recordSeconds: number },
  collision: Awaited<ReturnType<typeof loadBspCollision>>,
): Promise<string> {
  if (!collision) throw new Error("Map unavailable");
  const port = Number(option("--port", "7787"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid recording port");
  const control = option("--bot-control");
  const ownedIds: string[] = [];
  let socket: WebSocket | null = null;
  const localBots = new BotServer(0);
  const gametype = new Deathmatch();
  const matchConfig = gametype.getMatchConfig();
  // Fixture duration owns the end boundary; prevent an early auto-save.
  gametype.getMatchConfig = () => ({ ...matchConfig, scoreLimit: 0 });
  const server = new GameServer(
    {
      port,
      serverName: "timedemo-authoring",
      mapName: recipe.map,
      matchGametype: "ffa",
      maxClients: recipe.bots,
      tickRate: 125,
      snapshotRate: 60,
      certPath: "",
      keyPath: "",
    },
    gametype,
  );
  const request = (message: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Bot control disconnected"));
      const timeout = setTimeout(() => {
        ws.off("message", received);
        reject(new Error("Bot control request timed out"));
      }, 60000);
      const received = (data: Buffer) => {
        clearTimeout(timeout);
        ws.off("message", received);
        try {
          const result = JSON.parse(data.toString());
          if (result.type === "error") reject(new Error(result.error));
          else resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      ws.once("message", received);
      ws.send(JSON.stringify(message));
    });
  try {
    server.setCollisionWorld(collision.collision);
    server.setSpawnPoints(collision.spawnPoints, collision.teamSpawnPoints);
    server.setMapData(collision.entities, collision.models);
    server.setPickupItems(collision.pickups);
    server.setTriggerVolumes(collision.triggers);
    if (collision.pvs) server.setPVSData(collision.pvs);
    await server.start();
    if (control) {
      const url = new URL(control);
      if (url.protocol !== "ws:" || !["localhost", "127.0.0.1"].includes(url.hostname))
        throw new Error("Bot control must be local ws://localhost or ws://127.0.0.1");
      socket = new WebSocket(control, {
        headers: { [BOT_SECRET_HEADER]: loadBotSecret(resolveDataDir(option("--data-dir"))) },
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Bot control connection timed out")), 10000);
        socket?.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket?.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    }
    for (let i = 0; i < recipe.bots; i++) {
      cancellation.signal.throwIfAborted();
      const options = { name: `timedemo-${i + 1}`, difficulty: recipe.difficulty };
      if (control) {
        const result = await request({ type: "add_bot", gameServerUrl: `ws://localhost:${port}`, options });
        ownedIds.push(String(result.botId));
      } else await localBots.addBot(`ws://localhost:${port}`, options);
      console.log(`[Fixture] Joined bot ${i + 1}/${recipe.bots}`);
    }
    await wait(2000);
    // Same development recording boundary as record-demo.ts; no live server is altered.
    const match = (server as unknown as { gametypeController: { matchState: { transition(phase: MatchPhase): void } } })
      .gametypeController.matchState;
    match.transition(MatchPhase.Active);
    server.startRecording();
    console.log(`[Fixture] Recording ${recipe.recordSeconds}s on isolated port ${port}`);
    await wait(recipe.recordSeconds * 1000);
    const file = await server.stopRecording();
    if (!file) throw new Error("Recorder produced no demo");
    return file;
  } finally {
    for (const botId of ownedIds) {
      try {
        await request({ type: "remove_bot", botId });
      } catch (error) {
        console.warn(`[Fixture] Could not release owned bot ${botId}: ${String(error)}`);
      }
    }
    socket?.close();
    await localBots.stop();
    await server.stop();
  }
}

async function main() {
  if (args.includes("--help")) {
    console.log(
      "Usage: npm run benchmark:fixture -- [--recipe <json>] [--demo <shagdemo>] [--bot-control ws://127.0.0.1:9100] [--data-dir <dir>] [--port 7787] [--dry-run]",
    );
    return;
  }
  const valuedOptions = new Set(["--recipe", "--demo", "--bot-control", "--data-dir", "--port"]);
  const seenOptions = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (seenOptions.has(args[i])) throw new Error(`Duplicate option: ${args[i]}`);
    seenOptions.add(args[i]);
    if (args[i] === "--dry-run") continue;
    if (!valuedOptions.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value: ${args[i]}`);
    i++;
  }
  const recipePath = path.resolve(option("--recipe", "benchmarks/recipes/wdm2-ffa10.json")!);
  const recipeText = fs.readFileSync(recipePath, "utf8");
  const recipe = JSON.parse(recipeText);
  if (
    recipe.schemaVersion !== 1 ||
    typeof recipe.map !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(recipe.map) ||
    recipe.gametype !== "ffa" ||
    recipe.generatorVersion !== 1 ||
    recipe.scoreLimit !== 0 ||
    recipe.timeLimit !== 600 ||
    !isFixtureId(recipe.name ?? "") ||
    !["easy", "medium", "hard"].includes(recipe.difficulty) ||
    !Number.isInteger(recipe.seed) ||
    recipe.seed < 0 ||
    recipe.seed > 4294967295 ||
    !Number.isInteger(recipe.bots) ||
    recipe.bots < 2 ||
    recipe.bots > 10 ||
    !Number.isFinite(recipe.recordSeconds) ||
    recipe.recordSeconds < 60 ||
    recipe.recordSeconds > 300
  )
    throw new Error("Unsupported fixture recipe");
  // Validate the full schedule/profile before opening any server or bot seats.
  validateTimedemoFixture({
    ...recipe,
    id: recipe.name,
    demo: {
      file: "demo.shagdemo",
      sha256: "0".repeat(64),
      map: recipe.map,
      players: recipe.bots,
      tickRate: 125,
      version: 3,
    },
    segments: recipe.segments.map((s: TimedemoSegment) =>
      s.camera === "spectator"
        ? { ...s, targets: ["player_1"] }
        : {
            ...s,
            keyframes: [
              { tick: s.start, position: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 1 } },
              { tick: s.end, position: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 1 } },
            ],
          },
    ),
  });
  if (args.includes("--dry-run")) {
    console.log(
      JSON.stringify(
        {
          recipe,
          input: option("--demo") ?? "new isolated local recording",
          botControl: option("--bot-control") ?? "owned in-process bots",
          output: "public/data/benchmarks/<immutable hash ID>",
        },
        null,
        2,
      ),
    );
    return;
  }
  const map = await loadBspCollision(recipe.map);
  if (!map) throw new Error(`Indexed ${recipe.map} map unavailable`);
  const source = option("--demo") ?? (await record(recipe, map));
  const bytes = new Uint8Array(fs.readFileSync(source));
  const reader = await DemoReader.fromFile(bytes);
  const header = reader.readHeader();
  const frames = reader.readAllFrames();
  if (
    header.map !== recipe.map ||
    !["ffa", "deathmatch"].includes(header.gametype.toLowerCase()) ||
    header.players.length !== recipe.bots ||
    !header.tickRate ||
    !frames.length
  )
    throw new Error(`Recording must contain a current ${recipe.bots}-player ${recipe.map} FFA roster`);
  const firstTick = frames[0].tick;
  const duration = (frames[frames.length - 1].tick - firstTick) / header.tickRate;
  if (duration < recipe.startSeconds + recipe.durationSeconds)
    throw new Error(`Recording too short: ${duration.toFixed(1)}s logical timeline`);
  const at = (seconds: number): DemoFrame => {
    const tick = firstTick + (recipe.startSeconds + seconds) * header.tickRate;
    let lo = 0,
      hi = frames.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].tick <= tick) lo = mid;
      else hi = mid;
    }
    return frames[lo];
  };
  const ids = [...new Set(frames.flatMap((f) => [...f.state.entities.keys()].filter(isClientKey)))].sort();
  if (ids.length !== recipe.bots) throw new Error(`Expected ${recipe.bots} player entities, found ${ids.length}`);
  let seed = recipe.seed >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const segments: TimedemoSegment[] = recipe.segments.map((segment: TimedemoSegment) => {
    const targets = [...ids];
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [targets[i], targets[j]] = [targets[j], targets[i]];
    }
    if (segment.camera === "spectator") return { ...segment, targets };
    // Freeze a camera track derived from recorded movement, never live bot AI.
    const keyframes = [];
    for (let seconds = segment.start; seconds <= segment.end + 0.001; seconds += 0.1) {
      const frame = at(seconds);
      const id = selectTimedemoTarget(targets, frame.state);
      const entity = id ? frame.state.entities.get(id) : null;
      const transform = entity?.getComponent("transform") as
        | { position?: { x: number; y: number; z: number }; rotation?: { x?: number; y?: number } }
        | undefined;
      if (!transform?.position) throw new Error("No living actor available for camera route");
      const origin = transform.position;
      const raised = { ...origin, y: origin.y + 100 };
      const trace = map.collision.trace(origin, raised);
      const position = { ...origin, y: origin.y + Math.max(0, 100 * trace.fraction - 8) };
      const yaw = transform.rotation?.y ?? 0;
      const lookAt = { x: position.x + Math.sin(yaw) * 300, y: position.y - 30, z: position.z + Math.cos(yaw) * 300 };
      keyframes.push({
        tick: Math.min(segment.end, Number(seconds.toFixed(4))),
        position,
        lookAt,
        fov: recipe.profile.fov,
      });
    }
    return { ...segment, keyframes };
  });
  const recordingHash = hash(bytes);
  const coverage = segments.map((segment) => {
    const phaseFrames = frames.filter((frame) => {
      const seconds = (frame.tick - firstTick) / header.tickRate - recipe.startSeconds;
      return seconds >= segment.start && seconds < segment.end;
    });
    const povFireEvents = phaseFrames.reduce((count, frame) => {
      const target = selectTimedemoTarget(segment.targets ?? [], frame.state);
      return count + frame.state.events.filter((e) => e.type === "weapon_fire" && e.entityId === target).length;
    }, 0);
    if (segment.camera === "spectator" && !povFireEvents)
      throw new Error(
        `Candidate lacks watched bot gunfire in ${segment.name}; record again or revise the saved recipe`,
      );
    return { phase: segment.name, snapshots: phaseFrames.length, povFireEvents };
  });
  const manifest = validateTimedemoFixture({
    schemaVersion: 1,
    id: `${recipe.name}-v1-${recordingHash.slice(0, 12)}-${hash(recipeText).slice(0, 8)}`,
    demo: {
      file: "demo.shagdemo",
      sha256: recordingHash,
      map: header.map,
      players: ids.length,
      tickRate: header.tickRate,
      version: header.version,
    },
    startSeconds: recipe.startSeconds,
    durationSeconds: recipe.durationSeconds,
    seed: recipe.seed,
    profile: recipe.profile,
    segments,
    provenance: {
      recipe: path.relative(process.cwd(), recipePath).replace(/\\/g, "/"),
      recipeSha256: hash(recipeText),
      generatedAt: new Date().toISOString(),
      source: path.basename(source),
      routePolicy: recipe.routePolicy,
      outerRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      fpsRevision: execFileSync("git", ["-C", "src/games/fps", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      routeAcceptance: "generated; browser clearance/coverage acceptance pending",
      coverage,
      authoringScoreLimit: 0,
      outerDirty: !!execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(),
      fpsDirty: !!execFileSync("git", ["-C", "src/games/fps", "status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8",
      }).trim(),
    },
  } satisfies TimedemoFixture);
  const base = path.resolve("public/data/benchmarks");
  const output = path.join(base, manifest.id);
  if (fs.existsSync(output)) throw new Error("Immutable fixture already exists; do not overwrite it");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "demo.shagdemo"), bytes);
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  const indexFile = path.join(base, "index.json");
  const index: string[] = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : [];
  fs.writeFileSync(indexFile, JSON.stringify([...new Set([...index, manifest.id])].sort(), null, 2));
  console.log(
    `[Fixture] Created ${manifest.id}; ${ids.length} players, ${duration.toFixed(1)}s. Browser route acceptance pending.`,
  );
}

main()
  .catch((error) => {
    console.error(`[Fixture] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.connected) process.disconnect();
    // Native bot-inference handles survive their network cleanup. This CLI
    // exits only after record() has awaited its owned bots and server closing.
    process.exit(process.exitCode ?? 0);
  });
