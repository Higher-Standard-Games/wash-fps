import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,119}$/.test(id);

export function deriveOutlineVariant(base, baseBytes, outline, axis = 'cl_player_outline') {
  if (!validId(base?.id) || base?.schemaVersion !== 1 || ![0, 1].includes(outline) ||
      base.demo?.file !== 'demo.shagdemo' || !/^[a-f0-9]{64}$/.test(base.demo?.sha256) || !base.profile?.requiredCvars)
    throw new Error('Invalid base fixture or outline variant');
  if (!['cl_player_outline', 'cl_player_outline_proxy'].includes(axis) ||
    (axis === 'cl_player_outline_proxy' && base.profile.requiredCvars.cl_player_outline !== 1)) throw new Error('Invalid comparison axis/profile');
  const sourceHash = hash(baseBytes);
  const variant = structuredClone(base);
  variant.id = `${axis === 'cl_player_outline_proxy' ? 'player-outline-proxy-v1' : 'player-outlines-v1'}-${sourceHash.slice(0, 16)}-${outline}`;
  variant.profile.requiredCvars[axis] = outline;
  variant.provenance = { ...variant.provenance, derivedProfile: {
    generator: 'src/games/fps/scripts/benchmarks/outline-comparison.mjs', version: 1,
    baseFixture: base.id, baseManifestSha256: sourceHash, change: { [axis]: outline },
  } };
  return variant;
}

export function planOutlineSeries(backends, repeats) {
  if (!Array.isArray(backends) || !backends.length || new Set(backends).size !== backends.length ||
      backends.some(b => !['webgl2', 'webgpu'].includes(b)) || !Number.isInteger(repeats) || repeats < 1 || repeats > 10)
    throw new Error('Invalid comparison schedule');
  const runs = [];
  for (let repetition = 0; repetition < repeats; repetition++) {
    const order = repetition % 2 ? [...backends].reverse() : backends;
    for (const backend of order) for (const outline of repetition % 2 ? [0, 1] : [1, 0])
      runs.push({ repetition: repetition + 1, backend, outline });
  }
  return runs;
}

export function summarizeOutlineSeries(attempts, requiredRuns, axis = 'cl_player_outline') {
  const groups = {};
  let comparisonIdentity;
  for (const attempt of attempts) {
    const key = `${attempt.backend}:${axis === 'cl_player_outline_proxy' ? 'proxy' : 'outline'}-${attempt.outline}`;
    const group = groups[key] ??= { valid: [], rejected: [] };
    // Raw workload/source gates are retained, never reset after skipped events.
    let accepted = attempt.exitCode === 0 && attempt.meta?.captureMode === 'timing-only' &&
      attempt.meta?.complete && attempt.meta?.valid && attempt.meta?.stableSource &&
      attempt.meta?.exceptions?.length === 0 && attempt.meta?.developer?.before === false && attempt.meta?.developer?.after === false &&
      attempt.report?.runs?.[0]?.valid === true && attempt.report?.fixture?.id === attempt.fixture &&
      attempt.report?.fixture?.profile?.requiredCvars?.[axis] === attempt.outline &&
      attempt.meta.backend === attempt.backend && attempt.report.backend === attempt.backend;
    if (axis === 'cl_player_outline_proxy' && attempt.outline === 1) {
      const coverage = attempt.report?.runs?.[0]?.summary?.outlineProxy;
      accepted &&= coverage?.requestedFrames > 0 && coverage.unreadyFrames === 0 && coverage.rejectedFrames === 0 &&
        coverage.fallbackPasses === 0 && coverage.routedPasses > 0 &&
        !!attempt.report.runs[0].outlineProxyAssets?.proxySha256;
    }
    if (accepted) {
      const profile = structuredClone(attempt.report.fixture.profile);
      delete profile.requiredCvars[axis];
      const cvars = { ...attempt.report.environment.cvars }; delete cvars[axis];
      // Backend is the comparison axis; browser/source/route/profile stay fixed.
      const identity = JSON.stringify({ source: attempt.meta.sourceBefore, browser: attempt.meta.version.Browser,
        demo: attempt.report.fixture.demo, segments: attempt.report.fixture.segments, profile, cvars,
        seed: attempt.report.fixture.seed, start: attempt.report.fixture.startSeconds, duration: attempt.report.fixture.durationSeconds,
        viewport: attempt.report.environment.viewport, dpr: attempt.report.environment.devicePixelRatio, harness: attempt.harnessSha256 });
      if (comparisonIdentity === undefined) comparisonIdentity = identity;
      else if (identity !== comparisonIdentity) accepted = false;
    }
    (accepted ? group.valid : group.rejected).push(attempt);
  }
  const percentiles = values => {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = (sorted.length - 1) / 2;
    return { median: (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2, min: sorted[0], max: sorted.at(-1) };
  };
  const metric = (runs, phase, name) => percentiles(runs.map(a => {
    const result = phase === 'whole-tour' ? a.report.runs[0].summary : a.report.runs[0].phases[phase];
    return result?.[name]?.p95;
  }).filter(Number.isFinite));
  return Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, {
    validRuns: group.valid.length, rejectedRuns: group.rejected.length, enoughRuns: group.valid.length >= requiredRuns,
    acceptedArtifacts: group.valid.map(a => a.directory), rejectedArtifacts: group.rejected.map(a => a.directory),
    phases: Object.fromEntries(['whole-tour', ...new Set(group.valid.flatMap(a => Object.keys(a.report.runs[0].phases)))].map(phase =>
      [phase, Object.fromEntries(['wallMs', 'sceneCpuMs', 'animationMs', 'drawCalls', 'triangles'].map(name => [name, metric(group.valid, phase, name)]))])),
  }]));
}

async function main() {
  const options = { fixture: 'wdm2-ffa10-v1-095f355747e8-f47d4c2a', repeats: 5, backends: 'webgl2,webgpu' };
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i].replace(/^--/, '');
    if (name === 'dry-run') { options.dryRun = true; continue; }
    if (name === 'prepare-only') { options.prepareOnly = true; continue; }
    if (name === 'proxy') { options.proxy = true; continue; }
    if (!['fixture', 'repeats', 'backends', 'out'].includes(name) || !process.argv[i + 1]) throw new Error('Invalid comparison option');
    options[name] = process.argv[++i];
  }
  if (!validId(options.fixture)) throw new Error('Invalid base fixture ID');
  options.repeats = Number(options.repeats);
  const plan = planOutlineSeries(options.backends.split(','), options.repeats);
  const baseDir = path.join(root, 'public/data/benchmarks', options.fixture);
  const baseBytes = await fs.readFile(path.join(baseDir, 'manifest.json'));
  const base = JSON.parse(baseBytes);
  if (base.id !== options.fixture) throw new Error('Base identity mismatch');
  const axis = options.proxy ? 'cl_player_outline_proxy' : 'cl_player_outline';
  const variants = [0, 1].map(outline => deriveOutlineVariant(base, baseBytes, outline, axis));
  if (options.dryRun) { console.log(JSON.stringify({ options, variants, plan,
    estimatedMinimumMinutes: plan.length * (base.durationSeconds + base.startSeconds) * 2 / 60,
    mode: 'fresh headed sessions, unprofiled, no trace wrappers; bounded attempts, rejected runs retained' }, null, 2)); return; }
  const demo = await fs.readFile(path.join(baseDir, 'demo.shagdemo'));
  if (hash(demo) !== base.demo.sha256) throw new Error('Base recording hash mismatch');
  const out = path.resolve(root, options.out ?? `public/data/benchmarks/results/${new Date().toISOString().replace(/[:.]/g, '-')}-outline-comparison`);
  const relative = path.relative(root, out);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output must be in workspace');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out); // Never overwrite an earlier series.
  for (const variant of variants) {
    const dir = path.join(root, 'public/data/benchmarks', variant.id);
    const manifestBytes = JSON.stringify(variant, null, 2);
    try { await fs.mkdir(dir); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await fs.readFile(path.join(dir, 'manifest.json'), 'utf8') !== manifestBytes ||
          hash(await fs.readFile(path.join(dir, 'demo.shagdemo'))) !== base.demo.sha256) throw new Error('Existing variant differs; preserve immutable fixtures');
      continue;
    }
    await fs.writeFile(path.join(dir, 'demo.shagdemo'), demo);
    await fs.writeFile(path.join(dir, 'manifest.json'), manifestBytes);
  }
  const indexFile = path.join(root, 'public/data/benchmarks/index.json');
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  if (!Array.isArray(index) || index.some(id => !validId(id))) throw new Error('Invalid fixture index');
  await fs.writeFile(indexFile, JSON.stringify([...new Set([...index, ...variants.map(v => v.id)])].sort(), null, 2));
  const series = { schemaVersion: 1, options, axis, baseFixture: base.id, baseManifestSha256: hash(baseBytes),
    demoSha256: base.demo.sha256, variants, plan, attempts: [], summary: {},
    limitations: [options.proxy ? 'Full/reduced outline geometry, normal player outlines remain enabled in both.' : 'Outline-off is a diagnostic quality change, not an accepted optimization.',
      '400ms status polling and production timedemo counters remain; CPU sampling/trace wrappers are disabled.',
      'At least five valid runs per variant are recommended. Report insufficient valid runs and overlapping spread honestly.'] };
  await fs.writeFile(path.join(out, 'plan.json'), JSON.stringify(series, null, 2));
  if (options.prepareOnly) { console.log(JSON.stringify({ variants: variants.map(v => v.id), out }, null, 2)); return; }
  let interrupted = false, child;
  process.on('SIGINT', () => { interrupted = true; if (child?.connected) child.send('cancel'); });
  for (const [index, item] of plan.entries()) {
    if (interrupted) break;
    const fixture = variants[item.outline].id;
    const directory = path.join(out, `${String(index + 1).padStart(2, '0')}-${item.backend}-outline-${item.outline}`);
    console.log(`[outlines] ${index + 1}/${plan.length}: ${item.backend}, outline ${item.outline}, repetition ${item.repetition}`);
    const exitCode = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [path.join(root, 'src/games/fps/scripts/benchmarks/profile-timedemo.mjs'),
        '--timing-only', '--backends', item.backend, '--fixture', fixture, '--out', directory],
      { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
      child.on('error', reject); child.on('exit', code => resolve(code ?? 1));
    });
    const folder = path.join(directory, `1-${item.backend}`);
    const read = async name => { try { return JSON.parse(await fs.readFile(path.join(folder, name), 'utf8')); } catch { return null; } };
    const captureSeries = await fs.readFile(path.join(directory, 'series.json'), 'utf8').then(JSON.parse).catch(() => null);
    series.attempts.push({ ...item, fixture, directory: path.relative(root, directory), exitCode, harnessSha256: captureSeries?.harnessSha256,
      meta: await read('run.json'), report: await read('timedemo.json') });
    series.summary = summarizeOutlineSeries(series.attempts, options.repeats, axis);
    await fs.writeFile(path.join(out, 'series.json'), JSON.stringify(series, null, 2));
  }
  console.log(JSON.stringify(series.summary, null, 2));
  console.log(`[outlines] saved ${out}`);
  if (interrupted || Object.values(series.summary).some(g => !g.enoughRuns) || series.attempts.length !== plan.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
