import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOutlineVariant, planOutlineSeries, summarizeOutlineSeries } from '../outline-comparison.mjs';

const base = { schemaVersion: 1, id: 'base', demo: { file: 'demo.shagdemo', sha256: 'a'.repeat(64) },
  profile: { width: 1280, height: 720, requiredCvars: { r_glow: 0, cl_player_outline: 1 } }, segments: [{ camera: 'freefly' }], provenance: {} };

const attempt = (outline, value) => ({ backend: 'webgl2', outline, fixture: `variant-${outline}`, directory: `run-${value}`, exitCode: 0,
  meta: { backend: 'webgl2', captureMode: 'timing-only', complete: true, valid: true, stableSource: true, exceptions: [],
    developer: { before: false, after: false }, sourceBefore: { sourceChangeSha256: 'same' }, version: { Browser: 'test' } },
  report: { backend: 'webgl2', environment: { cvars: { cl_player_outline: outline } }, fixture: { ...base, id: `variant-${outline}`,
    profile: { ...base.profile, requiredCvars: { ...base.profile.requiredCvars, cl_player_outline: outline } } },
    runs: [{ valid: true, summary: { wallMs: { p95: value } }, phases: {} }] } });

test('derives immutable profile identities without changing the recording, route or base fixture', () => {
  const bytes = JSON.stringify(base), off = deriveOutlineVariant(base, bytes, 0), on = deriveOutlineVariant(base, bytes, 1);
  assert.notEqual(off.id, on.id);
  assert.deepEqual(off.demo, on.demo); assert.deepEqual(off.segments, base.segments);
  assert.equal(base.profile.requiredCvars.cl_player_outline, 1);
  assert.equal(off.profile.requiredCvars.cl_player_outline, 0);
  assert.equal(off.provenance.derivedProfile.baseFixture, base.id);
  assert.throws(() => deriveOutlineVariant(base, bytes, 2));
});

test('balances backend and variant order with bounded reproducible attempts', () => {
  const plan = planOutlineSeries(['webgl2', 'webgpu'], 5);
  assert.equal(plan.length, 20);
  assert.deepEqual(plan.slice(0, 4).map(p => [p.backend, p.outline]), [['webgl2', 1], ['webgl2', 0], ['webgpu', 1], ['webgpu', 0]]);
  assert.deepEqual(plan.slice(4, 8).map(p => [p.backend, p.outline]), [['webgpu', 0], ['webgpu', 1], ['webgl2', 0], ['webgl2', 1]]);
  assert.throws(() => planOutlineSeries(['webgpu', 'webgpu'], 5));
});

test('proxy profiles retain normal outlines, recordings and routes and reject silent fallback', () => {
  const off = deriveOutlineVariant(base, JSON.stringify(base), 0, 'cl_player_outline_proxy');
  const on = deriveOutlineVariant(base, JSON.stringify(base), 1, 'cl_player_outline_proxy');
  assert.equal(off.profile.requiredCvars.cl_player_outline, 1);
  assert.equal(on.profile.requiredCvars.cl_player_outline_proxy, 1);
  assert.notEqual(on.id, deriveOutlineVariant(base, JSON.stringify(base), 1).id);
  assert.deepEqual(off.demo, on.demo); assert.deepEqual(off.segments, on.segments);
  const run = attempt(1, 10);
  run.report.fixture.profile.requiredCvars.cl_player_outline_proxy = 1;
  run.report.runs[0].summary.outlineProxy = { requestedFrames: 10, unreadyFrames: 0, rejectedFrames: 0, fallbackPasses: 0, routedPasses: 40 };
  run.report.runs[0].outlineProxyAssets = { proxySha256: 'a'.repeat(64) };
  assert.equal(summarizeOutlineSeries([run], 1, 'cl_player_outline_proxy')['webgl2:proxy-1'].validRuns, 1);
  run.report.runs[0].summary.outlineProxy.fallbackPasses = 1;
  assert.equal(summarizeOutlineSeries([run], 1, 'cl_player_outline_proxy')['webgl2:proxy-1'].validRuns, 0);
});

test('rejects skipped/unstable/profiled or changed-source runs and reports run-level median/spread', () => {
  const rejected = attempt(1, 100); rejected.report.runs[0].valid = false;
  const changed = attempt(0, 1); changed.meta.sourceBefore.sourceChangeSha256 = 'different';
  const summary = summarizeOutlineSeries([attempt(1, 10), attempt(1, 20), rejected, attempt(0, 8), changed], 2);
  assert.equal(summary['webgl2:outline-1'].validRuns, 2);
  assert.equal(summary['webgl2:outline-1'].rejectedRuns, 1);
  assert.deepEqual(summary['webgl2:outline-1'].phases['whole-tour'].wallMs, { median: 15, min: 10, max: 20 });
  assert.equal(summary['webgl2:outline-0'].validRuns, 1);
  assert.equal(summary['webgl2:outline-0'].enoughRuns, false);
  assert.equal(summary['webgl2:outline-0'].rejectedRuns, 1);
});

test('preserves benchmark eligibility gates and excludes mismatched comparison workloads', () => {
  const failures = [
    a => { a.exitCode = 1; },
    a => { a.meta.captureMode = 'cpu-profile'; },
    a => { a.meta.complete = false; },
    a => { a.meta.valid = false; },
    a => { a.meta.stableSource = false; },
    a => { a.meta.exceptions = [{ text: 'renderer failure' }]; },
    a => { a.meta.developer.after = true; },
    a => { a.meta.backend = 'webgpu'; },
    a => { a.report.backend = 'webgpu'; },
    a => { a.report.fixture.id = 'wrong-fixture'; },
    a => { a.report.fixture.profile.requiredCvars.cl_player_outline = 0; },
    a => { a.meta.version.Browser = 'other-browser'; },
    a => { a.report.fixture.demo.sha256 = 'b'.repeat(64); },
    a => { a.report.fixture.segments = [{ camera: 'spectator' }]; },
    a => { a.report.environment.cvars.cl_player_pose_hz = 0; },
    a => { a.harnessSha256 = 'different-harness'; },
  ];
  for (const fail of failures) {
    const baseline = structuredClone(attempt(1, 10)), rejected = structuredClone(attempt(1, 100));
    fail(rejected);
    const group = summarizeOutlineSeries([baseline, rejected], 2)['webgl2:outline-1'];
    assert.equal(group.validRuns, 1); assert.equal(group.rejectedRuns, 1);
    assert.deepEqual(group.phases['whole-tour'].wallMs, { median: 10, min: 10, max: 10 });
    assert.equal(group.enoughRuns, false);
  }
});
