/** Fine splash spray: one pooled mesh of soft, velocity-aligned camera-facing quads. */
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { MAX_DROPLETS } from "./SplashDroplets";

const VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec2 sprayData;
attribute vec3 sprayVelocity;
uniform mat4 view;
uniform mat4 projection;
varying vec2 vCorner;
varying float vOpacity;
void main() {
  vec4 centre = view * vec4(position, 1.0);
  vec2 velocity = (view * vec4(sprayVelocity, 0.0)).xy;
  float speed = length(velocity);
  vec2 axis = speed > 1.0 ? velocity / speed : vec2(0.0, 1.0);
  vec2 side = vec2(axis.y, -axis.x);
  vec2 corner = uv * 2.0 - 1.0;
  float width = 0.45 * sprayData.x;
  float height = (0.6 + min(speed * 0.003, 1.4)) * sprayData.x;
  centre.xy += side * corner.x * width + axis * corner.y * height;
  gl_Position = projection * centre;
  vCorner = corner;
  // Suppress near-eye specks instead of expanding them into giant screen blobs.
  vOpacity = sprayData.y * smoothstep(4.0, 20.0, centre.z);
}`;

const FRAGMENT = `
precision highp float;
uniform float uOutputLinear;
varying vec2 vCorner;
varying float vOpacity;
void main() {
  float radius2 = dot(vCorner, vCorner);
  float alpha = (1.0 - smoothstep(0.05, 1.0, radius2)) * vOpacity * 0.45;
  if (alpha < 0.005) discard;
  vec3 colour = vec3(0.58, 0.70, 0.74);
  if (uOutputLinear > 0.5) colour = pow(colour, vec3(2.2));
  gl_FragColor = vec4(colour, alpha);
}`;

export class SplashDropletRenderer {
  private mesh: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private shown = 0;
  private readonly positions = new Float32Array(MAX_DROPLETS * 4 * 3);
  private readonly velocities = new Float32Array(MAX_DROPLETS * 4 * 3);
  private readonly data = new Float32Array(MAX_DROPLETS * 4 * 2);

  constructor(private readonly scene: Scene) {}

  start(): boolean {
    if (this.mesh) return true;
    try {
      const mesh = this.mesh = new Mesh("liquid-splash-droplets", this.scene);
      const uv = new Float32Array(MAX_DROPLETS * 8);
      const indices: number[] = [];
      for (let i = 0; i < MAX_DROPLETS; i++) {
        uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
        const v = i * 4;
        indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
      mesh.setVerticesData("position", this.positions, true, 3);
      mesh.setVerticesData("uv", uv, false, 2);
      mesh.setVerticesData("sprayData", this.data, true, 2);
      mesh.setVerticesData("sprayVelocity", this.velocities, true, 3);
      mesh.setIndices(indices);
      const material = this.material = new ShaderMaterial("liquid-splash-spray-mat", this.scene,
        { vertexSource: VERTEX, fragmentSource: FRAGMENT }, {
          attributes: ["position", "uv", "sprayData", "sprayVelocity"],
          uniforms: ["view", "projection", "uOutputLinear"], needAlphaBlending: true,
        });
      material.disableDepthWrite = true;
      material.backFaceCulling = false;
      material.setFloat("uOutputLinear", 0);
      material.onBindObservable.add(() => {
        const p = this.scene.imageProcessingConfiguration;
        material.getEffect().setFloat("uOutputLinear", p.isEnabled && p.applyByPostProcess ? 1 : 0);
      });
      mesh.material = material;
      mesh.metadata = { effectOwned: true, excludeFromWaterCapture: true };
      mesh.layerMask &= ~0x10000000;
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.setEnabled(false);
      return true;
    } catch (error) {
      console.warn("[Water] Could not build splash spray", error);
      this.dispose();
      return false;
    }
  }

  update(positions: Float32Array, sizes: Float32Array, count: number,
    velocities?: Float32Array, opacities?: Float32Array): void {
    const mesh = this.mesh;
    if (!mesh) return;
    this.shown = Math.max(0, Math.min(MAX_DROPLETS, Math.floor(count), sizes.length, Math.floor(positions.length / 3)));
    if (!this.shown) { mesh.setEnabled(false); return; }
    for (let i = 0; i < this.shown; i++) {
      for (let corner = 0; corner < 4; corner++) {
        const vertex = i * 4 + corner;
        for (let axis = 0; axis < 3; axis++) {
          this.positions[vertex * 3 + axis] = positions[i * 3 + axis];
          this.velocities[vertex * 3 + axis] = velocities?.[i * 3 + axis] ?? 0;
        }
        this.data[vertex * 2] = sizes[i];
        this.data[vertex * 2 + 1] = opacities?.[i] ?? 1;
      }
    }
    // Refresh bounds for transparent sorting at the actual splash location.
    // Unused vertices must not pull the bounding centre toward world origin.
    for (let v = this.shown * 4; v < MAX_DROPLETS * 4; v++) {
      this.positions[v * 3] = positions[0];
      this.positions[v * 3 + 1] = positions[1];
      this.positions[v * 3 + 2] = positions[2];
    }
    mesh.updateVerticesData("position", this.positions, true);
    mesh.updateVerticesData("sprayVelocity", this.velocities);
    mesh.updateVerticesData("sprayData", this.data);
    mesh.subMeshes[0].indexCount = this.shown * 6;
    // A shortened index range is no longer a global SubMesh; Babylon then
    // needs its own bounds for transparent sorting, not just the mesh bounds.
    mesh.subMeshes[0].refreshBoundingInfo();
    mesh.setEnabled(true);
  }

  get isAvailable(): boolean { return this.mesh !== null; }
  get drawnCount(): number { return this.shown; }

  dispose(): void {
    this.mesh?.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.shown = 0;
  }
}
