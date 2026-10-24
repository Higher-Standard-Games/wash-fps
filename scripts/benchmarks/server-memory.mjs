/** Real dedicated-process memory benchmark. Profiling samples are opt-in. */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { bunExecutable } from "../../../../../scripts/benchmarks/runtime-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`);
  return args[index + 1];
};
const seconds = Number(option("--seconds", "15"));
const warmup = Number(option("--warmup", "5"));
const repeats = Number(option("--repeats", "3"));
if (!(seconds > 0 && warmup >= 0 && Number.isInteger(repeats) && repeats > 0)) throw new Error("Invalid duration/repeats");
const maps = option("--maps", "wdm2,wfdm5,wfdm11").split(",");
const runtimes = option("--runtimes", "node-vite,node,bun").split(",");
const destination = path.resolve(root, option("--out", ".cache/server-memory/report.json"));
const entry = path.resolve(root, option("--entry", "dist-server/headless-netserver-v2.mjs"));
const bun = runtimes.includes("bun") ? bunExecutable(option("--bun", "bun")) : null;
const diagnosticGC = args.includes("--diagnostic-gc");
const clients = Number(option("--clients", "0"));
const recording = args.includes("--recording");
if (recording && clients < 2) throw new Error("--recording requires at least 2 clients");
if (!Number.isInteger(clients) || clients < 0 || clients > 16) throw new Error("--clients must be 0..16");
const outputDir = path.dirname(destination);
fs.mkdirSync(outputDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))];
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
function privateBytes(pid) {
  if (process.platform !== "win32") return null;
  const value = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).PrivateMemorySize64`], { encoding: "utf8", windowsHide: true });
  return Number(value.trim());
}
const report = {
  createdAt: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  platform: process.platform, arch: process.arch, osRelease: os.release(),
  workload: { seconds, warmup, repeats, clients, recording, phase: recording ? "active match cycles" : "warmup", tickRate: 125, entry, diagnosticGC,
    artifactSha256: fs.existsSync(entry) ? createHash("sha256").update(fs.readFileSync(entry)).digest("hex") : null },
  limitations: ["Warmup movement/combat workload; not recorded active-match or ten-process capacity evidence",
    "RSS includes shared pages; ArrayBuffer bytes are a subset of external memory; profiler overhead is included",
    "Windows private bytes are sampled once after warm-up, not peak commit; RSS peak is sampled, not OS high-water"],
  runs: [],
};
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const map of maps) {
    for (const runtime of runtimes) {
      const name = `${runtime}-${map}-${repeat}`;
      const profile = path.join(outputDir, `${name}.jsonl`);
      fs.writeFileSync(profile, "");
      const preload = path.join(root, "scripts/server-memory-preload.mjs");
      const serverArgs = ["--map", map, "--gametype", "ffa", "--port", String(await port()), "--cert", "", "--key", ""];
      let executable, launch;
      if (runtime === "node-vite") {
        executable = process.execPath;
        launch = ["--import", pathToFileURL(preload).href, path.join(root, "node_modules/vite-node/vite-node.mjs"), "src/games/fps/cli/headless-netserver-v2.ts", ...serverArgs];
      } else if (runtime === "node") {
        executable = process.execPath; launch = ["--import", pathToFileURL(preload).href, entry, ...serverArgs];
      } else if (runtime === "bun") {
        executable = bun; launch = ["--preload", preload, entry, ...serverArgs];
      } else throw new Error(`Unknown runtime: ${runtime}`);
      const log = fs.createWriteStream(path.join(outputDir, `${name}.log`));
      const started = performance.now();
      const env = { ...process.env, SHAG_SERVER_PROFILE: profile, SHAG_WARMUP: recording ? "10s" : "0",
        SHAG_DEBUG: "tickrate", SHAG_TIMELIMIT: "60s", SHAG_DEMO_DIR: path.join(outputDir, `${name}-demos`) };
      if (diagnosticGC) {
        env.SHAG_SERVER_PROFILE_GC = "1";
        if (runtime !== "bun") launch.unshift("--expose-gc");
      } else { delete env.SHAG_SERVER_PROFILE_GC; delete env.SHAG_SERVER_PROFILE_HEAP; }
      for (const key of ["SHAG_MATCH_ADMISSION", "SHAG_MATCH_RESULT_SECRET", "SHAG_MATCH_RESULT_OUTBOX"]) delete env[key];
      const child = spawn(executable, launch, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let closed = false;
      const exited = new Promise((resolve) => {
        child.once("exit", (code, signal) => { closed = true; resolve({ code, signal }); });
        child.once("error", (error) => { closed = true; resolve({ error: error.message }); });
      });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      let tail = "";
      let workload, readyTimer;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${name}: startup timeout`)), 60000);
          child.once("error", (error) => { clearTimeout(timer); reject(error); });
          child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${name}: startup exit ${code}`)); });
          child.stdout.on("data", (data) => {
            tail = (tail + data.toString()).slice(-4096);
            if (tail.includes("Ready for connections")) { clearTimeout(timer); resolve(); }
          });
        });
        const readyMs = performance.now() - started;
        if (clients) {
          const driver = await import(pathToFileURL(path.join(root, "dist-server/ServerBenchmarkClient.mjs")).href);
          workload = await driver.connectBenchmarkClients(Number(serverArgs[5]), clients);
          if (recording) { workload.ready(); readyTimer = setInterval(() => workload.ready(), 2000); }
        }
        await sleep(warmup * 1000);
        if (closed) throw new Error(`${name}: exited during warmup`);
        const committed = privateBytes(child.pid);
        const sampleStart = Date.now();
        await sleep(seconds * 1000);
        if (closed) throw new Error(`${name}: exited during measurement`);
        const samples = fs.readFileSync(profile, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
        const listening = samples.find((sample) => sample.stage === "listening");
        if (!listening) throw new Error(`${name}: missing listening marker`);
        const steady = samples.filter((sample) => sample.stage === "sample" && sample.timestamp >= sampleStart);
        if (!steady.length) throw new Error(`${name}: missing steady samples`);
        const memory = {};
        for (const key of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"]) {
          const values = steady.map((s) => s.memory[key]).filter(Number.isFinite);
          memory[key] = values.length ? { median: quantile(values, .5), max: Math.max(...values) } : null;
        }
        const first = steady[0], last = steady.at(-1);
        const logText = fs.readFileSync(path.join(outputDir, `${name}.log`), "utf8");
        const rates = [...logText.matchAll(/tickrate: ([0-9.]+)Hz actual.*maxTickWork ([0-9.]+)ms/g)];
        const demoDir = env.SHAG_DEMO_DIR;
        const demos = fs.existsSync(demoDir) ? fs.readdirSync(demoDir).filter((file) => file.endsWith(".shagdemo")) : [];
        if (recording && seconds > 90 && !demos.length) throw new Error(`${name}: no finalized recordings`);
        const run = { name, runtime, map, repeat, pid: child.pid, version: listening.version, readyMs,
          cpuPercentOfOneCore: 100 * ((last.cpu.user + last.cpu.system - first.cpu.user - first.cpu.system) / 1000) / (last.elapsedMs - first.elapsedMs),
          firstMemory: first.memory, lastMemory: last.memory,
          tickRate: rates.length ? { medianHz: quantile(rates.map((m) => Number(m[1])), .5),
            minimumHz: Math.min(...rates.map((m) => Number(m[1]))), maxWorkMs: Math.max(...rates.map((m) => Number(m[2]))) } : null,
          recordings: demos.length, recordingBytes: demos.reduce((sum, file) => sum + fs.statSync(path.join(demoDir, file)).size, 0),
          privateBytes: committed, memory, peakSampledRss: Math.max(...samples.map((s) => s.memory.rss)),
          stages: samples.filter((s) => s.stage !== "sample"), samples: steady.length, network: workload?.stats() };
        if (run.network && (run.network.decodeOrSocketErrors || run.network.snapshots < clients * seconds))
          throw new Error(`${name}: protocol workload failed: ${JSON.stringify(run.network)}`);
        report.runs.push(run);
        fs.writeFileSync(destination, JSON.stringify(report, null, 2));
        console.log(`${name}: RSS ${(memory.rss.median / 1048576).toFixed(1)} MiB; private ${committed === null ? "n/a" : (committed / 1048576).toFixed(1)} MiB; ready ${readyMs.toFixed(0)} ms`);
      } finally {
        clearInterval(readyTimer);
        await workload?.close();
        if (!closed) {
          child.stdin.once("error", () => {});
          child.stdin.write("quit\n");
        }
        await Promise.race([exited, sleep(5000)]);
        if (!closed) { child.kill("SIGKILL"); await exited; }
        log.end();
      }
    }
  }
}
console.log(`Report: ${destination}`);
