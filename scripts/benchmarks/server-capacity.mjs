/** Stepped idle-process capacity sample; only owned children are stopped. */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bunExecutable } from "../../../../../scripts/benchmarks/runtime-command.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const runtime = option("--runtime", "bun"), map = option("--map", "wfdm11");
const count = Number(option("--instances", "10"));
if (!["node", "bun"].includes(runtime) || !Number.isInteger(count) || count < 1 || count > 10)
  throw new Error("Expected --runtime node|bun and --instances 1..10");
const executable = runtime === "bun" ? bunExecutable(option("--bun", "bun")) : process.execPath;
const output = path.resolve(option("--out", `.cache/server-capacity-${runtime}/report.json`));
fs.mkdirSync(path.dirname(output), { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const owned = [];
const report = { runtime, map, createdAt: new Date().toISOString(), platform: process.platform,
  workload: "Idle dedicated servers; no clients. Concurrent recording soaks may also be running separately.",
  memoryAccounting: "Summed RSS double-counts shared pages; Windows private working set excludes shared resident pages; private bytes are committed memory.",
  steps: [] };
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return port;
}
try {
  for (let i = 0; i < count; i++) {
    if (os.freemem() < 700 * 1048576) throw new Error("Capacity trial stopped: less than 700 MiB host memory available");
    const profile = path.join(path.dirname(output), `${i}.jsonl`);
    fs.writeFileSync(profile, "");
    const preload = path.join(root, "scripts/server-memory-preload.mjs");
    const launch = [runtime === "bun" ? "--preload" : "--import", runtime === "bun" ? preload : pathToFileURL(preload).href,
      path.join(root, "dist-server/headless-netserver-v2.mjs"), "--map", map, "--port", String(await freePort()), "--cert", "", "--key", ""];
    const env = { ...process.env, SHAG_SERVER_PROFILE: profile, SHAG_WARMUP: "0" };
    for (const key of ["SHAG_MATCH_ADMISSION", "SHAG_MATCH_RESULT_SECRET", "SHAG_MATCH_RESULT_OUTBOX", "SHAG_SERVER_PROFILE_GC", "SHAG_SERVER_PROFILE_HEAP"]) delete env[key];
    const child = spawn(executable, launch, { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const log = fs.createWriteStream(path.join(path.dirname(output), `${i}.log`));
    const item = { child, profile, log, closed: false };
    owned.push(item);
    item.exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => { item.closed = true; item.exitStatus = { code, signal }; resolve(); });
      child.once("error", (error) => { item.closed = true; item.exitStatus = { error: error.message }; resolve(); });
    });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server ready timeout")), 60000);
      let tail = "";
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Startup exited ${code}`)); });
      child.stdout.on("data", (data) => {
        tail = (tail + data.toString()).slice(-4096);
        if (tail.includes("Ready for connections")) { clearTimeout(timeout); resolve(); }
      });
    });
    if ([1, 2, 5, count].includes(i + 1)) {
      await sleep(10000);
      if (owned.some((item) => item.closed)) throw new Error("A measured server exited unexpectedly");
      const samples = owned.map((item) => fs.readFileSync(item.profile, "utf8").split("\n").slice(0, -1).filter(Boolean).map(JSON.parse).at(-1));
      let windows = null;
      if (process.platform === "win32") {
        const ids = owned.map((item) => item.child.pid).join(",");
        const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command",
          `@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -in @(${ids}) } | Select-Object IDProcess,PrivateBytes,WorkingSetPrivate) | ConvertTo-Json -Compress`],
          { encoding: "utf8", windowsHide: true });
        windows = JSON.parse(raw.trim()); if (!Array.isArray(windows)) windows = [windows];
        if (windows.length !== owned.length) throw new Error("Missing Windows process accounting rows");
      }
      const step = { instances: owned.length, pids: owned.map((item) => item.child.pid),
        summedRss: samples.reduce((sum, s) => sum + s.memory.rss, 0),
        summedHeapUsed: samples.reduce((sum, s) => sum + s.memory.heapUsed, 0),
        windows, freeHostBytes: os.freemem() };
      report.steps.push(step); fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(`${runtime} ${step.instances} servers: summed RSS ${(step.summedRss / 1048576).toFixed(1)} MiB`);
    }
  }
} finally {
  await Promise.all(owned.map(async (item) => {
    if (!item.closed) { item.child.stdin.once("error", () => {}); item.child.stdin.write("quit\n"); }
    const timer = setTimeout(() => { if (!item.closed) item.child.kill("SIGKILL"); }, 5000);
    await item.exit; clearTimeout(timer); item.log.end();
  }));
  report.exits = owned.map((item) => ({ pid: item.child.pid, ...item.exitStatus }));
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
}
console.log(`Report: ${output}`);
