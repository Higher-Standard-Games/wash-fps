import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceCpuProfile, summarizeCpuProfile } from '../../../../../scripts/benchmarks/cpu-profile.mjs';
import { installReadinessProbe } from '../../../../../scripts/benchmarks/readiness-probe.mjs';
import { installPlaybackProbe } from '../../../../../scripts/benchmarks/playback-probe.mjs';
import { installOutlineProbe } from '../../../../../scripts/benchmarks/outline-probe.mjs';
import { installCameraProbe } from '../../../../../scripts/benchmarks/camera-probe.mjs';
import { readEngineGraphics } from '../../../../../scripts/benchmarks/graphics-probe.mjs';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const options = {
  fixture: 'wdm2-ffa10-v1-095f355747e8-f47d4c2a', backends: 'webgl2,webgpu',
  port: 3117, interval: 250, ncm: 0, browser: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i].replace(/^--/, '');
  if (name === 'dry-run') { options.dryRun = true; continue; }
  if (name === 'trace-readiness') { options.traceReadiness = true; continue; }
  if (name === 'trace-playback') { options.tracePlayback = true; continue; }
  if (name === 'trace-outlines') { options.traceOutlines = true; continue; }
  if (name === 'trace-cameras') { options.traceCameras = true; continue; }
  if (name === 'timing-only') { options.timingOnly = true; continue; }
  if (!['fixture', 'backends', 'port', 'interval', 'ncm', 'browser', 'out'].includes(name) || !process.argv[i + 1])
    throw new Error(`Unknown or incomplete option: ${process.argv[i]}`);
  options[name] = process.argv[++i];
}
options.port = Number(options.port); options.interval = Number(options.interval); options.ncm = Number(options.ncm);
const backends = options.backends.split(',');
if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(options.fixture) ||
    backends.some(b => !['webgl2', 'webgpu'].includes(b)) ||
    !Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 ||
    !Number.isInteger(options.interval) || options.interval < 100 || options.interval > 10000 ||
    ![0, 1].includes(options.ncm)) throw new Error('Invalid profiling options');
if (options.timingOnly && (options.traceReadiness || options.tracePlayback || options.traceOutlines || options.traceCameras))
  throw new Error('Timing-only captures cannot install diagnostic trace wrappers');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(root, options.out ?? `public/data/benchmarks/results/${stamp}-codex-profile`);
if (!out.startsWith(root) || out === root) throw new Error('Output must be inside this workspace');
const fixture = JSON.parse(await fs.readFile(path.join(root, 'public/data/benchmarks', options.fixture, 'manifest.json'), 'utf8'));
if (fixture.id !== options.fixture) throw new Error('Fixture identity mismatch');
if (options.dryRun) {
  console.log(JSON.stringify({ ...options, developer: 0, out, phases: fixture.segments.map(s => s.name),
    mode: options.timingOnly ? 'visible browser, unprofiled timedemo; 400ms progress polling' : 'visible browser, one profiled timedemo per requested backend', profile: fixture.profile }, null, 2));
  process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(callback, timeout, label) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { const value = await callback(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(400);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}
function sourceIdentity() {
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28 }).trim();
  const fps = path.join(root, 'src/games/fps');
  const diff = git(['diff', '--binary', 'HEAD', '--', 'src', 'package.json', 'vite.config.ts', 'public/engine.json']) +
    git(['diff', '--binary', 'HEAD'], fps);
  const digest = createHash('sha256').update(diff);
  for (const [cwd, args] of [[root, ['ls-files', '--others', '--exclude-standard', 'src']],
    [fps, ['ls-files', '--others', '--exclude-standard']]]) {
    for (const file of git(args, cwd).split('\n').filter(file => /\.(tsx?|json)$/.test(file)))
      digest.update(cwd + '/' + file).update(readFileSync(path.join(cwd, file)));
  }
  const playerRecipePath = 'config/player-model-vanguard.json';
  const playerRecipeBytes = readFileSync(path.join(root, playerRecipePath));
  const playerRecipe = JSON.parse(playerRecipeBytes);
  digest.update(playerRecipePath).update(playerRecipeBytes);
  const playerAssets = [`public/data/${playerRecipe.package}`];
  if (fixture.profile.requiredCvars.cl_player_outline_proxy !== undefined) playerAssets.push(
    'public/data/benchmarks/outline-proxy/player-outline-proxy-v1.glb',
    'public/data/benchmarks/outline-proxy/player-outline-proxy-v1.glb.json',
  );
  for (const file of playerAssets) digest.update(file).update(readFileSync(path.join(root, file)));
  return { outer: git(['rev-parse', 'HEAD']), fps: git(['rev-parse', 'HEAD'], fps),
    sourceChangeSha256: digest.digest('hex'),
    dirty: git(['status', '--short']), fpsDirty: git(['status', '--short'], fps) };
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timeout); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown' && this.errors.length < 100) {
        this.errors.push(message.params.exceptionDetails);
      }
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(new Error('CDP closed')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

await fs.mkdir(path.dirname(out), { recursive: true });
await fs.mkdir(out, { recursive: false });
// The timedemo is the game's: with no SHAG_APP and no local .shag-application.json,
// Vite would serve the engine example, so fall back to the configured default game.
if (!process.env.SHAG_APP && !existsSync(path.join(root, '.shag-application.json'))) {
  const { defaultGame } = JSON.parse(readFileSync(path.join(root, 'public/engine.json'), 'utf8'));
  process.env.SHAG_APP = `src/games/${defaultGame}`;
}
const { createServer } = await import('vite');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'),
  cacheDir: path.join(root, 'node_modules/.vite-codex-profile'), logLevel: 'warn',
  server: { host: '127.0.0.1', port: options.port, strictPort: true, hmr: false, watch: null } });
let activeBrowser = null, interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
process.on('message', message => { if (message === 'cancel') interrupted = true; });
const series = { createdAt: new Date().toISOString(), fixture: options.fixture, options,
  harnessSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  readinessProbeSha256: options.traceReadiness ? createHash('sha256').update(installReadinessProbe.toString()).digest('hex') : null,
  playbackProbeSha256: options.tracePlayback ? createHash('sha256').update(installPlaybackProbe.toString()).digest('hex') : null,
  outlineProbeSha256: options.traceOutlines ? createHash('sha256').update(installOutlineProbe.toString()).digest('hex') : null,
  cameraProbeSha256: options.traceCameras ? createHash('sha256').update(installCameraProbe.toString()).digest('hex') : null,
  graphicsProbeSha256: createHash('sha256').update(readEngineGraphics.toString()).digest('hex'),
  runs: [] };
try {
  await server.listen();
  for (const [index, backend] of backends.entries()) {
    if (interrupted) throw new Error('Profiling cancelled');
    const name = `${index + 1}-${backend}`, directory = path.join(out, name);
    await fs.mkdir(directory);
    const dataDir = path.join(root, 'node_modules/.cache/shag-edge-profile', `${stamp}-${index}`);
    await fs.mkdir(dataDir, { recursive: true });
    const sourceBefore = sourceIdentity();
    console.log(`[profile] ${name}: launch visible Edge; ${options.timingOnly ? 'CPU sampling disabled' : `${options.interval}us sampling`}`);
    const child = spawn(options.browser, [
      `--user-data-dir=${dataDir}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-features=CalculateNativeWinOcclusion,msEdgeSignin',
      '--window-size=1440,900', '--new-window', 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    let spawnError; child.on('error', error => { spawnError = error; });
    let page, browser;
    const captures = [], screenshots = new Set();
    let recording = false;
    try {
      const port = await waitFor(async () => {
        if (spawnError) throw spawnError;
        const text = await fs.readFile(path.join(dataDir, 'DevToolsActivePort'), 'utf8');
        const port = Number(text.split('\n')[0]);
        return port > 0 && port <= 65535 ? port : null;
      }, 30000, 'Edge debugging port');
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      browser = await CDP.connect(version.webSocketDebuggerUrl); activeBrowser = browser;
      const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find(t => t.type === 'page' && t.url === 'about:blank'), 10000, 'Owned Edge tab');
      page = await CDP.connect(target.webSocketDebuggerUrl);
      await page.send('Runtime.enable'); await page.send('Page.enable');
      await page.send('Page.navigate', { url: `http://127.0.0.1:${options.port}/?renderer=${backend}&ncm=${options.ncm}&benchmarkLabel=${sourceBefore.outer.slice(0, 8)}-codex-profile` });
      await waitFor(async () => page.evaluate(`(async () => {
        const { LoadingScreen } = await import('/src/engine/ui/LoadingScreen.ts');
        LoadingScreen.forceDismiss();
        const { CommandRegistry } = await import('/src/engine/console/CommandRegistry.ts');
        const { CameraSystem } = await import('/src/engine/camera/CameraSystem.ts');
        const engine = CameraSystem.getInstance().getCamera()?.getScene()?.getEngine();
        return !!engine && engine.frameId > 1 && CommandRegistry.getInstance().getCommands().has('timedemo');
      })()`), 120000, 'Game initialization');
      const graphics = {
        browser: await browser.send('SystemInfo.getInfo').then(info => info.gpu).catch(error => ({ unavailable: error.message })),
        engine: await page.evaluate(`(async () => {
          const { CameraSystem } = await import('/src/engine/camera/CameraSystem.ts');
          const engine = CameraSystem.getInstance().getCamera().getScene().getEngine();
          return (${readEngineGraphics.toString()})(engine);
        })()`),
      };
      await fs.writeFile(path.join(directory, 'graphics.json'), JSON.stringify(graphics, null, 2));
      // Both CDP's Timestamp metric and CPU sample timestamps use Chromium's
      // monotonic clock. Bracket the metric with page clock readings and retain
      // the narrowest observed offset range rather than assuming a wall-clock origin.
      await page.send('Performance.enable');
      let clock;
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = await page.evaluate('performance.now()');
        const { metrics } = await page.send('Performance.getMetrics');
        const after = await page.evaluate('performance.now()');
        const timestamp = metrics.find(metric => metric.name === 'Timestamp')?.value;
        if (!Number.isFinite(timestamp)) throw new Error('CDP monotonic timestamp unavailable');
        const candidate = { lowerMs: timestamp * 1000 - after, upperMs: timestamp * 1000 - before,
          uncertaintyMs: after - before };
        if (!clock || candidate.uncertaintyMs < clock.uncertaintyMs) clock = candidate;
      }
      if (clock.uncertaintyMs > 25) throw new Error('CPU/page clock calibration is too uncertain');
      if (options.traceReadiness) await page.evaluate(`(async () => {
        const { CameraSystem } = await import('/src/engine/camera/CameraSystem.ts');
        const engine = CameraSystem.getInstance().getCamera().getScene().getEngine();
        window.__timedemoReadinessTrace = (${installReadinessProbe.toString()})(engine,
          () => window.__timedemoProfileProbe?.().progress ?? 'setup');
      })()`);
      // Starting the sampler can pause/deopt the page. Do it before any demo
      // advances, not during pre-roll; the full profile includes preparation
      // and warmup, while the phase slices below still use measured playheads.
      if (!options.timingOnly) {
        await page.send('Profiler.enable');
        await page.send('Profiler.setSamplingInterval', { interval: options.interval });
        const profilerBeforeMs = await page.evaluate('performance.now()');
        const profilerStartWall = Date.now();
        await page.send('Profiler.start');
        recording = true;
        const profilerAfterMs = await page.evaluate('performance.now()');
        await fs.writeFile(path.join(directory, 'profiling-start.json'), JSON.stringify({
          pageBeforeMs: profilerBeforeMs, pageAfterMs: profilerAfterMs,
          wallDurationMs: Date.now() - profilerStartWall, beforeTimedemoCommand: true,
      }, null, 2));
      }
      const setup = await page.evaluate(`(async () => {
        const { CommandRegistry } = await import('/src/engine/console/CommandRegistry.ts');
        const { Cvar } = await import('/src/engine/core/Cvar.ts');
        const { TimedemoService } = await import('/src/games/fps/client/TimedemoService.ts');
        const { DemoService } = await import('/src/games/fps/client/DemoService.ts');
        const { CameraSystem } = await import('/src/engine/camera/CameraSystem.ts');
        const registry = CommandRegistry.getInstance();
        const developer = await registry.executeChecked('developer 0');
        if (!developer.ok || Cvar.getBool('developer')) throw new Error('Could not disable development diagnostics');
        for (const [name, value] of Object.entries(${JSON.stringify({ cl_player_pose_hz: 30, ...fixture.profile.requiredCvars })})) {
          const result = await registry.executeChecked(name + ' ' + value);
          if (!result.ok) throw new Error('Profile setting failed: ' + name + ': ' + result.output);
        }
        const fixture = ${JSON.stringify({ startSeconds: fixture.startSeconds, segments: fixture.segments.map(({ name, start, end }) => ({ name, start, end })) })};
        window.__timedemoProfileProbe = () => {
          const service = TimedemoService.getInstance(), demo = DemoService.getInstance();
          const viewer = demo.activeDemoViewer, info = viewer?.getInfo();
          const firstTick = demo.loadedDemoReader?.readIndex().entries[0]?.tick;
          const seconds = info?.header && Number.isFinite(firstTick)
            ? (info.playheadTick - firstTick) / info.header.tickRate - fixture.startSeconds : null;
          return { progress: service.progress, status: service.report?.status,
            state: info?.state, seconds, hidden: document.hidden,
            phase: fixture.segments.find(s => seconds !== null && seconds >= s.start && seconds < s.end)?.name ?? null,
            frameId: CameraSystem.getInstance().getCamera()?.getScene()?.getEngine().frameId,
            tick: info?.playheadTick, at: performance.now() };
        };
        ${options.tracePlayback ? `const { DemoViewer } = await import('/src/games/fps/client/DemoViewer.ts');
        window.__timedemoPlaybackTrace = (${installPlaybackProbe.toString()})(DemoViewer, () => window.__timedemoProfileProbe());` : ''}
        ${options.traceOutlines ? `const scene = CameraSystem.getInstance().getCamera().getScene();
        const OutlineRenderer = scene.getOutlineRenderer().constructor;
        window.__timedemoOutlineTrace = (${installOutlineProbe.toString()})(scene.getEngine(), OutlineRenderer,
          () => window.__timedemoProfileProbe());` : ''}
        ${options.traceCameras ? `window.__timedemoCameraTrace = (${installCameraProbe.toString()})(
          CameraSystem.getInstance().getCamera().getScene(), () => window.__timedemoProfileProbe());` : ''}
        const result = await registry.executeChecked('timedemo ${options.fixture} --mode realtime --repeats 1');
        return { ...result, developer: Cvar.getBool('developer') };
      })()`);
      if (!setup.ok || !setup.output?.startsWith('Timedemo loading')) throw new Error(`Timedemo start failed: ${setup.output}`);
      const until = Date.now() + 360000;
      let lastProgress = '';
      const probes = [];
      while (Date.now() < until && !interrupted) {
        const probe = await page.evaluate('window.__timedemoProfileProbe()');
        if (probe.progress !== lastProgress) { lastProgress = probe.progress; console.log(`[profile] ${name}: ${lastProgress}`); }
        if (probe.progress.startsWith('warmup') && probe.state === 'playing' && probe.phase && !screenshots.has(probe.phase)) {
          const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
          await fs.writeFile(path.join(directory, `warmup-${probe.phase}.png`), Buffer.from(screenshot.data, 'base64'));
          await fs.writeFile(path.join(directory, `warmup-${probe.phase}.json`), JSON.stringify(probe, null, 2));
          screenshots.add(probe.phase);
        }
        if (probe.progress.startsWith('measure') && probe.phase) probes.push(probe);
        if (probe.status !== 'running') break;
        await sleep(400);
      }
      const report = await page.evaluate('window.timedemoReport ?? null');
      await fs.writeFile(path.join(directory, 'timedemo.json'), JSON.stringify(report, null, 2));
      await fs.writeFile(path.join(directory, 'probes.json'), JSON.stringify({ clock, probes }, null, 2));
      if (recording) {
        // Serialize only after playback ends. Stopping the profiler at every cut
        // paused the page long enough to skip demo events in the first attempt.
        const { profile } = await page.send('Profiler.stop');
        recording = false;
        await fs.writeFile(path.join(directory, 'timedemo-full.cpuprofile'), JSON.stringify(profile));
        for (const phase of fixture.segments) {
          const observed = probes.filter(probe => probe.phase === phase.name);
          if (observed.length < 2) throw new Error(`Insufficient phase observations: ${phase.name}`);
          const started = observed[0], stopped = observed.at(-1);
          const startTime = Math.ceil((started.at + clock.upperMs) * 1000);
          const endTime = Math.floor((stopped.at + clock.lowerMs) * 1000);
          const slice = sliceCpuProfile(profile, startTime, endTime);
          const frames = stopped.frameId - started.frameId;
          const summary = summarizeCpuProfile(slice, frames);
          const base = `${name}-${phase.name}`;
          await fs.writeFile(path.join(directory, `${base}.cpuprofile`), JSON.stringify(slice));
          const capture = { phase: phase.name, started, stopped, frames, clock,
            rawFile: `${base}.cpuprofile`, summary,
            boundaryWarning: 'Only the interior between observed same-phase probes; cut edges omitted. Frame count uncertainty is approximately one engine frame.' };
          await fs.writeFile(path.join(directory, `${base}-summary.json`), JSON.stringify(capture, null, 2));
          captures.push(capture);
          if (phase.camera === 'spectator' && report?.runs?.[0]) {
            const run = report.runs[0], thresholdMs = run.phases[phase.name]?.wallMs.p95;
            const slowFrames = [];
            for (let i = 1; i < run.samples.length; i++) {
              const previous = run.samples[i - 1], current = run.samples[i];
              if (previous.phase !== phase.name || current.phase !== phase.name || current.wallMs < thresholdMs ||
                  !Number.isFinite(previous.frameAtMs) || !Number.isFinite(current.frameAtMs)) continue;
              const start = Math.ceil((previous.frameAtMs + clock.upperMs) * 1000);
              const end = Math.floor((current.frameAtMs + clock.lowerMs) * 1000);
              if (start >= profile.startTime && end <= profile.endTime && end > start)
                slowFrames.push({ start, end, wallMs: current.wallMs, seconds: previous.seconds });
            }
            if (slowFrames.length) {
              const slow = { phase: phase.name, thresholdMs, selectedFrames: slowFrames,
                summary: summarizeCpuProfile(profile, slowFrames.length, slowFrames),
                scope: 'Hook-to-hook wall intervals ending in p95-or-slower frames; current and previous camera phase must match.' };
              await fs.writeFile(path.join(directory, `${base}-slow-frames.json`), JSON.stringify(slow, null, 2));
            }
          }
          console.log(`[profile] ${name} ${phase.name}: ${(summary.durationMs / 1000).toFixed(1)}s, ${frames} frames`);
        }
      }
      if (options.traceReadiness) {
        const readiness = await page.evaluate(`(() => {
          const trace = window.__timedemoReadinessTrace;
          try { return trace.snapshot(); } finally { trace.restore(); }
        })()`);
        await fs.writeFile(path.join(directory, 'readiness-trace.json'), JSON.stringify(readiness, null, 2));
      }
      if (options.tracePlayback) {
        const playback = await page.evaluate(`(() => {
          const trace = window.__timedemoPlaybackTrace;
          try { return trace.snapshot(); } finally { trace.restore(); }
        })()`);
        await fs.writeFile(path.join(directory, 'playback-trace.json'), JSON.stringify(playback, null, 2));
      }
      let outlineTraceValid = true;
      if (options.traceOutlines) {
        const outline = await page.evaluate(`(() => {
          const trace = window.__timedemoOutlineTrace;
          try { return trace.snapshot(); } finally { trace.restore(); }
        })()`);
        await fs.writeFile(path.join(directory, 'outline-trace.json'), JSON.stringify(outline, null, 2));
        outlineTraceValid = outline.meshDrawHookInstalled && outline.dropped === 0;
      }
      const sourceAfter = sourceIdentity();
      let cameraTraceValid = true;
      if (options.traceCameras) {
        const cameraTrace = await page.evaluate(`(() => {
          const trace = window.__timedemoCameraTrace;
          try { return trace.snapshot(); } finally { trace.restore(); }
        })()`);
        await fs.writeFile(path.join(directory, 'camera-trace.json'), JSON.stringify(cameraTrace, null, 2));
        cameraTraceValid = cameraTrace.dropped === 0 && cameraTrace.records.some(record => record.candidateCalls > 0);
      }
      const developerAfter = await page.evaluate(`(async () => {
        const { Cvar } = await import('/src/engine/core/Cvar.ts');
        return Cvar.getBool('developer');
      })()`);
      const stableSource = sourceBefore.outer === sourceAfter.outer && sourceBefore.fps === sourceAfter.fps &&
        sourceBefore.sourceChangeSha256 === sourceAfter.sourceChangeSha256;
      const result = { backend, version, graphics, sourceBefore, sourceAfter, stableSource,
        captureMode: options.timingOnly ? 'timing-only' : 'cpu-profile', outlineTraceValid, cameraTraceValid,
        developer: { before: setup.developer, after: developerAfter },
        captures: captures.map(({ summary, ...capture }) => ({ ...capture, topSelf: summary.bySelf.slice(0, 15) })),
        exceptions: page.errors, reportFile: 'timedemo.json',
        complete: report?.status === 'complete', valid: report?.runs?.[0]?.valid === true,
        limitations: [options.timingOnly ? 'No CPU sampler/trace wrappers; 400ms status polling and timedemo counters remain.' : 'Profiling overhead and 400ms polling; camera-cut edges omitted from CPU slices.',
          'Warmup screenshots are evidence at recorded playheads, not full camera-route acceptance.'] };
      await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify(result, null, 2));
      series.runs.push(result);
      console.log(`[profile] ${name}: ${report?.status}, valid=${result.valid}, sourceStable=${stableSource}`);
      if (!result.complete || !result.valid || !stableSource || !outlineTraceValid || !cameraTraceValid || setup.developer || developerAfter || (!options.timingOnly && captures.length !== fixture.segments.length))
        process.exitCode = 1;
    } catch (error) {
      await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ error: error.message, exceptions: page?.errors, sourceBefore }, null, 2));
      console.error(`[profile] ${name}: ${error.message}`); process.exitCode = 1;
    } finally {
      if (browser) await browser.send('Browser.close', {}, 5000).catch(() => {});
      page?.socket.close(); browser?.socket.close(); activeBrowser = null;
      await sleep(300);
      if (child.exitCode === null) child.kill();
    }
  }
} finally {
  if (activeBrowser) await activeBrowser.send('Browser.close', {}, 5000).catch(() => {});
  await server.close();
  await fs.writeFile(path.join(out, 'series.json'), JSON.stringify(series, null, 2));
  console.log(`[profile] saved ${out}`);
  // An IPC message listener keeps a spawned comparison child alive. Release
  // the cancellation channel once its browser/server/artifacts are retired.
  if (process.connected) process.disconnect();
}
