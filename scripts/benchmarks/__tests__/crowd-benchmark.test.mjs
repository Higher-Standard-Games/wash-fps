import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCrowdReports } from '../crowd-benchmark.mjs';

test('crowd summaries preserve invalid workloads, missing GPU data and cross-capture identity', () => {
  const make = (value, valid = true) => ({ valid: true, stableSource: true, exceptions: [], sourceBefore: { fingerprint: 'same' },
    report: { status: 'complete', environment: { backend: 'webgpu', render: [1280, 720] }, assets: [{ sha256: 'same' }],
      runs: [{ valid, count: 10, outline: 1, gpuSamplesMs: [], summary: { cpuMs: { p95: value }, wallMs: { p95: value },
        poseCpuMs: { p95: 1 }, drawCalls: { p50: 62 } } }] } });
  const otherSource = make(1); otherSource.sourceBefore.fingerprint = 'other';
  const otherAssets = make(1); otherAssets.report.assets[0].sha256 = 'changed';
  const otherHardware = make(1); otherHardware.hardware = { gpu: { devices: [{ driverVersion: 'changed' }] } };
  const failure = make(1); failure.exceptions.push({ text: 'GPU failure' });
  const group = summarizeCrowdReports([make(10), make(20), make(100, false), otherSource, otherAssets, otherHardware, failure])['webgpu:10:outline-1'];
  assert.equal(group.validRuns, 2); assert.equal(group.rejectedRuns, 5);
  assert.deepEqual(group.cpuP95Ms, { median: 15, min: 10, max: 20 });
  assert.equal(group.gpuP95Ms, null);
});
