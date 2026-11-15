/**
 * EmpCorePlugin — the moving lightning disc on the Search & Destroy bomb.
 *
 * The EMP bomb carries a disc of lightning on each of its two poles (the
 * model's ±Z). This plugin finds that disc by the model-space position of each
 * fragment, samples the base texture again at a rippling offset and adds the
 * result as purple light: the lightning wobbles in place, and bright rings run
 * outward from the centre. Above 1, bloom picks the core up.
 *
 * Model-space, not texture-space: the model's texture is an atlas, and the
 * disc is one island among hundreds. A position test keeps the effect on the
 * disc whatever the atlas layout, and the small warp stays inside the island.
 */

import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";

/** The disc's radius about the pole axis, in model units (the model spans about ±0.46). */
export const EMP_CORE_RADIUS = 0.24;
/** Fragments nearer the equator than this, in model units, are not on either disc. */
export const EMP_CORE_POLE_Z = 0.3;

/** Rings across the disc and how fast they run outward, in radians per model unit and per second. */
const RING_FREQUENCY = 90;
const RING_SPEED = 7;
/** How far the lightning wobbles, in texture coordinates (about four texels of the 1024 atlas). */
const WARP = 0.004;

const DECLARATIONS = "uniform vec4 empCoreShape;\nuniform vec4 empCoreTint;\n";

export class EmpCorePlugin extends MaterialPluginBase {
  /** Seconds, set by the owner each frame. */
  time = 0;
  /** How bright the core shines over the lit surface; 0 switches it off. */
  strength = 1;
  /** The core's colour, multiplied into the texture it samples. */
  readonly tint: [number, number, number] = [1.25, 0.55, 1.5];

  constructor(material: PBRMaterial) {
    super(material, "EmpCore", 310, { EMP_CORE: true }, true, false);
    this._enable(true);
  }

  override getClassName(): string {
    return "EmpCorePlugin";
  }

  override isCompatible(language: ShaderLanguage): boolean {
    return language === ShaderLanguage.GLSL || language === ShaderLanguage.WGSL;
  }

  override getUniforms(language?: ShaderLanguage) {
    const wgsl = language === ShaderLanguage.WGSL;
    return {
      ubo: [
        { name: "empCoreShape", size: 4, type: "vec4" },
        { name: "empCoreTint", size: 4, type: "vec4" },
      ],
      vertex: wgsl ? "" : DECLARATIONS,
      fragment: wgsl ? "" : DECLARATIONS,
    };
  }

  /** Written on every bind, frozen material or not: the time moves every frame. */
  override hardBindForSubMesh(buffer: UniformBuffer): void {
    buffer.updateFloat4("empCoreShape", EMP_CORE_RADIUS, EMP_CORE_POLE_Z, this.strength, this.time);
    buffer.updateFloat4("empCoreTint", this.tint[0], this.tint[1], this.tint[2], 0);
  }

  override getCustomCode(type: string, language?: ShaderLanguage): Record<string, string> | null {
    const wgsl = language === ShaderLanguage.WGSL;
    if (type === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: wgsl ? "varying vEmpPos: vec3f;" : "varying vec3 vEmpPos;",
        CUSTOM_VERTEX_MAIN_END: wgsl ? "vertexOutputs.vEmpPos = positionUpdated;" : "vEmpPos = positionUpdated;",
      };
    }
    if (type !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: wgsl ? "varying vEmpPos: vec3f;" : "varying vec3 vEmpPos;",
      CUSTOM_FRAGMENT_BEFORE_FOG: wgsl ? wgslCore() : glslCore(),
    };
  }
}

/** The sampling runs outside any branch: WGSL allows texture sampling only in uniform control flow. */
function glslCore(): string {
  return `#if defined(EMP_CORE) && defined(ALBEDO)
{
  vec3 empPos = vEmpPos;
  float empR = length(empPos.xy);
  float empOn = (1.0 - smoothstep(empCoreShape.x * 0.55, empCoreShape.x, empR))
    * smoothstep(empCoreShape.y, empCoreShape.y + 0.05, abs(empPos.z));
  float empAngle = atan(empPos.y, empPos.x);
  float empT = empCoreShape.w;
  vec2 empWarp = vec2(
    sin(empR * 55.0 - empT * 4.0 + empAngle * 3.0),
    cos(empR * 40.0 - empT * 3.1 - empAngle * 2.0)) * (${WARP.toFixed(4)} * empOn);
  vec3 empTexel = texture2D(albedoSampler, vAlbedoUV + empWarp).rgb;
  float empRing = 0.5 + 0.5 * sin(empR * ${RING_FREQUENCY.toFixed(1)} - empT * ${RING_SPEED.toFixed(1)});
  float empFlicker = 0.85 + 0.15 * sin(empT * 23.0 + empAngle * 5.0);
  finalColor.rgb += empTexel * empCoreTint.rgb
    * (empCoreShape.z * (0.35 + 0.9 * empRing * empRing) * empFlicker * empOn);
}
#endif`;
}

function wgslCore(): string {
  return `#if defined(EMP_CORE) && defined(ALBEDO)
{
  let empPos = fragmentInputs.vEmpPos;
  let empShape = uniforms.empCoreShape;
  let empR = length(empPos.xy);
  let empOn = (1.0 - smoothstep(empShape.x * 0.55, empShape.x, empR))
    * smoothstep(empShape.y, empShape.y + 0.05, abs(empPos.z));
  let empAngle = atan2(empPos.y, empPos.x);
  let empT = empShape.w;
  let empWarp = vec2f(
    sin(empR * 55.0 - empT * 4.0 + empAngle * 3.0),
    cos(empR * 40.0 - empT * 3.1 - empAngle * 2.0)) * (${WARP.toFixed(4)} * empOn);
  let empTexel = textureSample(albedoSampler, albedoSamplerSampler, fragmentInputs.vAlbedoUV + empWarp).rgb;
  let empRing = 0.5 + 0.5 * sin(empR * ${RING_FREQUENCY.toFixed(1)} - empT * ${RING_SPEED.toFixed(1)});
  let empFlicker = 0.85 + 0.15 * sin(empT * 23.0 + empAngle * 5.0);
  finalColor = vec4f(finalColor.rgb + empTexel * uniforms.empCoreTint.rgb
    * (empShape.z * (0.35 + 0.9 * empRing * empRing) * empFlicker * empOn), finalColor.a);
}
#endif`;
}
