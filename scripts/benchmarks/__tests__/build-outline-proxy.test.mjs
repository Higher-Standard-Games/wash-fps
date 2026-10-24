import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { reduceOutlineGeometry, rigIdentity, preserveNodeTransforms, readProxySource } from '../build-outline-proxy.mjs';

test('outline simplification preserves the real rig and retained skin/normal tuples and regenerates deterministically', async t => {
  const sourceRecipe = JSON.parse(await fs.readFile(new URL('../../../../../../benchmarks/recipes/player-outline-proxy-v1.json', import.meta.url), 'utf8'));
  let bytes; try { bytes = await readProxySource(sourceRecipe); } catch (e) { if (e.code === 'ENOENT') { t.skip('Optional local Vanguard package unavailable'); return; } throw e; }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS), recipe = { ratio: .25, error: .01, lockBorder: false };
  const regenerate = async () => {
    const d = await io.readBinary(bytes), before = rigIdentity(d), inventory = await reduceOutlineGeometry(d, recipe);
    assert.equal(rigIdentity(d), before);
    const output = preserveNodeTransforms(bytes, Buffer.from(await io.writeBinary(d)));
    assert.equal(rigIdentity(await io.readBinary(output)), before);
    assert.ok(inventory.reduce((n, p) => n + p.indices, 0) < inventory.reduce((n, p) => n + p.originalIndices, 0) / 2);
    return output;
  };
  assert.deepEqual(await regenerate(), await regenerate());
  await assert.rejects(reduceOutlineGeometry(await io.readBinary(bytes), { ...recipe, error: 1 }), /limits/);
});
