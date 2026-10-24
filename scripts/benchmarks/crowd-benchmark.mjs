import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function summarizeCrowdReports(captures) {
  const groups = {};
  let identity;
  for (const capture of captures) for (const run of capture.report?.runs ?? []) {
    const key = `${capture.report.environment.backend}:${run.count}:outline-${run.outline}${run.geometry ? `:${run.geometry}` : ''}`;
    const group = groups[key] ??= { accepted: [], rejected: 0 };
    const candidate = JSON.stringify({ source: capture.sourceBefore, browser: capture.version?.Browser,
      recipe: capture.report.recipe, assets: capture.report.assets, viewport: capture.report.environment.viewport,
      render: capture.report.environment.render, dpr: capture.report.environment.dpr, hardware: capture.hardware?.gpu?.devices });
    if (capture.valid === true && identity === undefined) identity = candidate;
    if (capture.valid === true && candidate === identity && capture.stableSource && !capture.exceptions?.length && capture.report.status === 'complete' && run.valid)
      group.accepted.push(run);
    else group.rejected++;
  }
  const range = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), mid = (sorted.length - 1) / 2;
    return sorted.length ? { median: (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2, min: sorted[0], max: sorted.at(-1) } : null;
  };
  return Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, { validRuns: group.accepted.length, rejectedRuns: group.rejected,
    cpuP95Ms: range(group.accepted.map(r => r.summary.cpuMs.p95)), wallP95Ms: range(group.accepted.map(r => r.summary.wallMs.p95)),
    poseP95Ms: range(group.accepted.map(r => r.summary.poseCpuMs.p95)),
    draws: range(group.accepted.map(r => r.summary.drawCalls.p50)),
    gpuP95Ms: range(group.accepted.map(r => {
      const sorted = [...r.gpuSamplesMs].sort((a, b) => a - b); if (!sorted.length) return null;
      const at = (sorted.length - 1) * .95, lo = Math.floor(at);
      return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo);
    })) }]));
}

class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = this.pending.get(message.id); if (!request) return;
        clearTimeout(request.timeout); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown' && this.errors.length < 100) this.errors.push(message.params.exceptionDetails);
    });
    socket.addEventListener('close', () => {
      for (const r of this.pending.values()) { clearTimeout(r.timeout); r.reject(new Error('CDP closed')); } this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new CDP(socket);
  }
  send(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function main() {
  const options = { backends: 'webgl2,webgpu', repeats: 5, counts: '0,2,5,10', port: 3118,
    browser: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' };
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i].replace(/^--/, '');
    if (name === 'dry-run') { options.dryRun = true; continue; }
    if (name === 'outline-proxy') { options.outlineProxy = true; continue; }
    if (name === 'visual') { options.visual = true; continue; }
    if (!['backends', 'repeats', 'counts', 'port', 'browser', 'out'].includes(name) || !process.argv[i + 1]) throw new Error('Invalid crowd option');
    options[name] = process.argv[++i];
  }
  options.repeats = Number(options.repeats); options.port = Number(options.port);
  const backends = options.backends.split(','), counts = options.counts.split(',').map(Number);
  if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 10 ||
      !Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 ||
      !backends.length || new Set(backends).size !== backends.length || backends.some(b => !['webgl2', 'webgpu'].includes(b)) ||
      !counts.length || new Set(counts).size !== counts.length || counts.some(n => ![0, 2, 5, 10].includes(n))) throw new Error('Invalid crowd workload');
  const recipeFile = path.join(root, 'benchmarks/recipes/player-crowd-v1.json'), recipeBytes = await fs.readFile(recipeFile), recipe = JSON.parse(recipeBytes);
  const playerRecipe = JSON.parse(await fs.readFile(path.join(root, 'config/player-model-vanguard.json'), 'utf8'));
  const playerArchivePath = path.join(root, 'public/data', playerRecipe.package);
  const playerZip = await JSZip.loadAsync(await fs.readFile(playerArchivePath));
  const assetFiles = [recipe.model.root + recipe.model.file, recipe.model.root + recipe.animation.file];
  if (options.outlineProxy) {
    recipe.outlineGeometry = ['full', 'proxy'];
    assetFiles.push('/data/benchmarks/outline-proxy/player-outline-proxy-v1.glb', '/data/benchmarks/outline-proxy/player-outline-proxy-v1.glb.json');
  }
  const assets = await Promise.all(assetFiles.map(async file => {
    const entry = file.startsWith(playerRecipe.root) ? playerZip.file(file) : null;
    if (file.startsWith(playerRecipe.root) && !entry) throw new Error(`Crowd player asset missing from package: ${file}`);
    const bytes = entry ? await entry.async('nodebuffer') : await fs.readFile(path.join(root, 'public', file.replace(/^\//, '')));
    return { file, sha256: hash(bytes) };
  }));
  const expectedRuns = counts.length * 2 * options.repeats * (options.outlineProxy ? 2 : 1);
  if (options.dryRun) { console.log(JSON.stringify({ options, recipe, assets, cases: backends.length * expectedRuns,
    mode: 'fixed crowd, fresh backend sessions; no CPU sampler, no game server or bot AI' }, null, 2)); return; }
  const out = path.resolve(root, options.out ?? `public/data/benchmarks/results/${new Date().toISOString().replace(/[:.]/g, '-')}-crowd`);
  const relative = path.relative(root, out);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output must be inside workspace');
  await fs.mkdir(path.dirname(out), { recursive: true }); await fs.mkdir(out);
  const sourceIdentity = () => {
    const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28 }).trim();
    const fps = path.join(root, 'src/games/fps'), digest = createHash('sha256');
    digest.update(git(['diff', '--binary', 'HEAD', '--', 'src', 'package.json', 'vite.config.ts'])).update(git(['diff', '--binary', 'HEAD'], fps));
    for (const file of git(['ls-files', '--others', '--exclude-standard', 'src']).split('\n').filter(f => /\.(ts|json)$/.test(f)))
      digest.update(file).update(readFileSync(path.join(root, file)));
    for (const file of ['src/games/fps/scripts/benchmarks/crowd-benchmark.mjs', 'benchmarks/crowd/index.html', 'benchmarks/recipes/player-crowd-v1.json', 'config/player-model-vanguard.json'])
      digest.update(file).update(readFileSync(path.join(root, file)));
    if (options.outlineProxy) for (const file of ['src/games/fps/scripts/benchmarks/build-outline-proxy.mjs', 'benchmarks/recipes/player-outline-proxy-v1.json'])
      digest.update(file).update(readFileSync(path.join(root, file)));
    for (const file of new Set(assetFiles.map(file => file.startsWith(playerRecipe.root) ? playerArchivePath : path.join(root, 'public', file.replace(/^\//, '')))))
      digest.update(file).update(readFileSync(file));
    return { outer: git(['rev-parse', 'HEAD']), fps: git(['rev-parse', 'HEAD'], fps), fingerprint: digest.digest('hex') };
  };
  const { createServer } = await import('vite');
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(root, 'node_modules/.vite-crowd'),
    logLevel: 'warn', server: { host: '127.0.0.1', port: options.port, strictPort: true, hmr: false, watch: null } });
  const series = { schemaVersion: 1, options, recipeSha256: hash(recipeBytes), assets, captures: [], summary: {} };
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; });
  const waitFor = async (callback, timeoutMs) => {
    const until = Date.now() + timeoutMs; let lastError;
    while (Date.now() < until) {
      if (interrupted) throw new Error('Crowd benchmark cancelled');
      try { const result = await callback(); if (result) return result; } catch (error) { lastError = error; }
      await pause(250);
    }
    throw new Error(`Crowd wait timed out: ${lastError?.message ?? 'not ready'}`);
  };
  try {
    await server.listen();
    for (const [index, backend] of backends.entries()) {
      if (interrupted) break;
      const directory = path.join(out, backend); await fs.mkdir(directory);
      const profile = path.join(root, 'node_modules/.cache/shag-edge-crowd', `${Date.now()}-${index}`); await fs.mkdir(profile, { recursive: true });
      const before = sourceIdentity();
      const child = spawn(options.browser, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=CalculateNativeWinOcclusion,msEdgeSignin',
        '--window-size=1440,900', '--new-window', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
      let spawnError; child.on('error', error => { spawnError = error; });
      let page, browser;
      try {
        console.log(`[crowd] ${backend}: ${counts.join('/')} visible actors, ${options.repeats} repeats`);
        const port = await waitFor(async () => {
          if (spawnError) throw spawnError;
          const lines = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); return Number(lines.split('\n')[0]) || null;
        }, 30000);
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); browser = await CDP.connect(version.webSocketDebuggerUrl);
        const hardware = await browser.send('SystemInfo.getInfo');
        const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url === 'about:blank'), 10000);
        page = await CDP.connect(target.webSocketDebuggerUrl); await page.send('Runtime.enable'); await page.send('Page.enable');
        const query = new URLSearchParams({ renderer: backend, repeats: String(options.repeats), counts: options.counts });
        if (options.outlineProxy) query.set('outlineProxy', '1');
        if (options.visual) query.set('visual', '1');
        await page.send('Page.navigate', { url: `http://127.0.0.1:${options.port}/benchmarks/crowd/index.html?${query}` });
        const shots = new Set();
        await waitFor(async () => {
          const probe = await page.evaluate(`(() => { const r=window.crowdBenchmark; return r && {status:r.status,stage:r.stage,tick:r.tick,currentCase:r.currentCase,review:r.review,error:r.error}; })()`);
          const c = probe?.currentCase;
          const shotKey = `${c?.outline}${c?.geometry ? `-${c.geometry}` : ''}`;
          if (probe?.stage === 'review') {
            const key = `review-${shotKey}-${probe.review.view}`;
            if (!shots.has(key)) {
              const shot = await page.send('Page.captureScreenshot', { format: 'png' });
              await fs.writeFile(path.join(directory, `${key}.png`), Buffer.from(shot.data, 'base64'));
              await fs.writeFile(path.join(directory, `${key}.json`), JSON.stringify(probe, null, 2)); shots.add(key);
            }
            await page.evaluate('window.continueCrowdReview?.()');
          }
          if (c?.count === 10 && c.repetition === 1 && probe.stage === 'warmup' && probe.tick >= 20 && probe.tick < 80 && !shots.has(shotKey)) {
            const shot = await page.send('Page.captureScreenshot', { format: 'png' });
            await fs.writeFile(path.join(directory, `crowd10-outline-${shotKey}.png`), Buffer.from(shot.data, 'base64'));
            await fs.writeFile(path.join(directory, `crowd10-outline-${shotKey}.json`), JSON.stringify(probe, null, 2)); shots.add(shotKey);
          }
          return probe && ['complete', 'failed'].includes(probe.status);
        }, 15 * 60 * 1000);
        const report = await page.evaluate('window.crowdBenchmark'), after = sourceIdentity();
        const stableSource = JSON.stringify(before) === JSON.stringify(after);
        const valid = report.status === 'complete' && report.environment.backend === backend && report.runs.length === expectedRuns &&
          report.runs.every(r => r.valid) && !page.errors.length && stableSource && JSON.stringify(report.assets) === JSON.stringify(assets);
        const capture = { backend, version, hardware, sourceBefore: before, sourceAfter: after, stableSource, exceptions: page.errors, valid, report };
        await fs.writeFile(path.join(directory, 'crowd.json'), JSON.stringify(capture, null, 2)); series.captures.push(capture);
        console.log(`[crowd] ${backend}: ${report.status}, valid=${valid}, runs=${report.runs.length}, stable=${stableSource}`);
        if (!valid) process.exitCode = 1;
      } catch (error) {
        await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ error: error.message, exceptions: page?.errors, sourceBefore: before }, null, 2));
        console.error(`[crowd] ${backend}: ${error.message}`); process.exitCode = 1;
      } finally {
        if (browser) await browser.send('Browser.close', {}, 5000).catch(() => {});
        page?.socket.close(); browser?.socket.close(); await pause(300); if (child.exitCode === null) child.kill();
      }
      series.summary = summarizeCrowdReports(series.captures);
      await fs.writeFile(path.join(out, 'series.json'), JSON.stringify(series, null, 2));
    }
  } finally { await server.close(); }
  console.log(JSON.stringify(series.summary, null, 2)); console.log(`[crowd] saved ${out}`);
  if (interrupted || series.captures.length !== backends.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
