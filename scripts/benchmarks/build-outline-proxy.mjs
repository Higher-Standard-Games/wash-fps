import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readProxySource(recipe) {
  const bytes = await fs.readFile(path.resolve(root, recipe.source));
  if (!recipe.sourceEntry) return bytes;
  const entry = (await JSZip.loadAsync(bytes)).file(recipe.sourceEntry);
  if (!entry) throw new Error(`Outline proxy source missing: ${recipe.sourceEntry}`);
  return entry.async('nodebuffer');
}

// Geometry may change; hierarchy, bind matrices and joint ordering may not.
export function rigIdentity(document) {
  const r = document.getRoot(), nodes = r.listNodes();
  return JSON.stringify({ nodes: nodes.map(n => ({ name: n.getName(), matrix: n.getMatrix(),
    children: n.listChildren().map(c => nodes.indexOf(c)), skin: r.listSkins().indexOf(n.getSkin()) })),
    skins: r.listSkins().map(s => ({ joints: s.listJoints().map(n => nodes.indexOf(n)),
      inverseBind: [...(s.getInverseBindMatrices()?.getArray() ?? [])] })) });
}

function tuples(primitive) {
  const attributes = ['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0'];
  const accessors = attributes.map(a => primitive.getAttribute(a));
  if (accessors.some(a => !a) || primitive.listTargets().length || primitive.getAttribute('JOINTS_1') || primitive.getAttribute('WEIGHTS_1'))
    throw new Error('Proxy requires ordinary four-influence skinned position/normal geometry');
  const rows = [];
  for (let i = 0; i < accessors[0].getCount(); i++) {
    const row = [];
    for (const a of accessors) row.push(...a.getElement(i, []));
    rows.push(JSON.stringify(row));
  }
  return rows;
}

export async function reduceOutlineGeometry(document, recipe) {
  if (!(recipe.ratio > 0 && recipe.ratio < 1 && recipe.error > 0 && recipe.error <= .02)) throw new Error('Invalid proxy simplification limits');
  const identity = rigIdentity(document), meshes = document.getRoot().listMeshes();
  const before = meshes.map(m => m.listPrimitives().map(p => ({ tuples: new Set(tuples(p)),
    vertices: p.getAttribute('POSITION').getCount(), indices: p.getIndices()?.getCount() })));
  // UV seams/tangents are unnecessary for an opaque outline and otherwise prevent welding.
  // Retain exact normals and skin tuples, so this never smooths or reweights the character.
  for (const mesh of meshes) for (const p of mesh.listPrimitives())
    for (const semantic of p.listSemantics()) if (!['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0'].includes(semantic)) p.setAttribute(semantic, null);
  await document.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: recipe.ratio, error: recipe.error, lockBorder: recipe.lockBorder }));
  if (identity !== rigIdentity(document) || meshes.length !== document.getRoot().listMeshes().length) throw new Error('Proxy changed rig or mesh structure');
  return meshes.flatMap((m, mi) => {
    if (m.listPrimitives().length !== before[mi].length) throw new Error('Proxy removed a body primitive');
    return m.listPrimitives().map((p, pi) => {
      const original = before[mi][pi];
      if (tuples(p).some(row => !original.tuples.has(row))) throw new Error('Proxy changed retained skin weights or vertex normals');
      return { mesh: m.getName(), primitive: pi, originalVertices: original.vertices, vertices: p.getAttribute('POSITION').getCount(),
        originalIndices: original.indices, indices: p.getIndices().getCount() };
    });
  });
}

export function preserveNodeTransforms(source, output) {
  const parse = bytes => JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  const original = parse(source), generated = parse(output);
  if (original.nodes.length !== generated.nodes.length) throw new Error('Proxy node count changed');
  original.nodes.forEach((node, i) => {
    if (node.name !== generated.nodes[i].name) throw new Error('Proxy node order changed');
    // The writer elides almost-identity TRS values. Preserve authored values exactly.
    for (const key of ['translation', 'rotation', 'scale', 'matrix']) {
      delete generated.nodes[i][key];
      if (node[key]) generated.nodes[i][key] = node[key];
    }
  });
  const json = Buffer.from(JSON.stringify(generated)), length = Math.ceil(json.length / 4) * 4;
  const rest = output.subarray(20 + output.readUInt32LE(12));
  const bytes = Buffer.alloc(20 + length + rest.length, 32);
  output.copy(bytes, 0, 0, 20); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(length, 12);
  json.copy(bytes, 20); rest.copy(bytes, 20 + length);
  return bytes;
}

async function main() {
  if (process.argv.length > 2) throw new Error('Uses the checked-in player-outline-proxy-v1 recipe; no positional arguments');
  const recipe = JSON.parse(await fs.readFile(path.join(root, 'benchmarks/recipes/player-outline-proxy-v1.json'), 'utf8'));
  const source = path.resolve(root, recipe.source), output = path.resolve(root, recipe.output);
  if (!source.startsWith(root) || !output.startsWith(path.join(root, 'public/data/benchmarks/outline-proxy/'))) throw new Error('Invalid proxy path');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS), sourceBytes = await readProxySource(recipe);
  const document = await io.readBinary(sourceBytes), inventory = await reduceOutlineGeometry(document, recipe);
  // Outline rendering uses the original body's material. Keep the authored rig and geometry only.
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) primitive.setMaterial(null);
  for (const material of document.getRoot().listMaterials()) material.dispose();
  for (const texture of document.getRoot().listTextures()) texture.dispose();
  const bytes = preserveNodeTransforms(sourceBytes, Buffer.from(await io.writeBinary(document)));
  if (rigIdentity(await io.readBinary(bytes)) !== rigIdentity(document)) throw new Error('GLB roundtrip changed the proxy rig');
  const manifest = { recipe, sourceSha256: hash(sourceBytes), proxySha256: hash(bytes),
    generatorSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), inventory,
    toolVersions: Object.fromEntries(await Promise.all(['@gltf-transform/core', '@gltf-transform/functions', 'meshoptimizer'].map(async name => {
      let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
      for (let i = 0; i < 4; i++, directory = path.dirname(directory)) {
        try { const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); if (pkg.name === name) return [name, pkg.version]; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      throw new Error(`Cannot identify proxy tool ${name}`);
    }))) };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, bytes);
  await fs.writeFile(`${output}.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
