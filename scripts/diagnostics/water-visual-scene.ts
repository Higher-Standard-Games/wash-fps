/** Browser-only diagnostic fixture. Served by water-visual-check.mjs, never shipped with the game. */
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { LiquidSurfaceSystem } from "../../../../engine/rendering/water/LiquidSurfaceSystem";
import { waterDisturbancesFor } from "../../../../engine/rendering/water/WaterDisturbances";
import { isReflectionOnlyActor, waterNeedsLocalReflection, waterActorReflectionStatus } from "../../../../engine/rendering/water/WaterActorReflection";
import { waterMapLights } from "../../../../engine/rendering/water/WaterSurfaceLighting";
import RenderVars from "../../../../engine/rendering/RenderVars";
import { LiquidInteractionSystem } from "../../liquid/client/LiquidInteractionSystem";
import { getCollisionManager } from "../../../../engine/physics/CollisionManager";
import { ContentFlags } from "../../../../engine/physics/ContentFlags";
import { createBSPCollisionWorld } from "../../simulation/collision/BSPCollisionWorld";

const canvas = document.querySelector("canvas")!;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.06, 0.07, 0.09, 1);
const camera = new FreeCamera("world", new Vector3(160, 95, -240), scene);
camera.minZ = 1;
camera.maxZ = 3000;
camera.layerMask = 0x0fffffff;
camera.setTarget(new Vector3(0, 10, 0));
const weapon = new FreeCamera("weapon", camera.position.clone(), scene);
weapon.rotation.copyFrom(camera.rotation);
weapon.layerMask = 0x10000000;
scene.activeCameras = [camera, weapon];
const params = new URLSearchParams(location.search);
const mapName = params.get("map");
const stock = params.get("renderer") === "stock";
const fullLoad = params.has("full");
if (params.has("postprocess")) {
  const { ImageProcessingPostProcess } = await import("@babylonjs/core/PostProcesses/imageProcessingPostProcess");
  const processing = new ImageProcessingPostProcess("water-check-image-processing", 1, camera, undefined, engine, false, undefined, scene.imageProcessingConfiguration);
  processing.inputIsLinear = true;
}
// Gameplay MapLoader warm-up awaits rendered frames while it is loading.
// The background-only fixture deliberately skipped that path.
const loadingRender = () => scene.render();
if (fullLoad) engine.runRenderLoop(loadingRender);
let root = new Mesh("diagnostic-room", scene);
function box(name: string, size: Vector3, position: Vector3, color: Color3) {
  const mesh = CreateBox(name, { width: size.x, height: size.y, depth: size.z }, scene);
  mesh.position.copyFrom(position);
  mesh.parent = root;
  const material = new StandardMaterial(name, scene);
  material.disableLighting = true;
  material.emissiveColor = color;
  mesh.material = material;
  return mesh;
}
if (!mapName) {
  box("floor", new Vector3(700, 5, 700), new Vector3(0, -32, 0), new Color3(0.32, 0.34, 0.38));
  box("red-wall", new Vector3(10, 220, 700), new Vector3(-340, 60, 0), new Color3(0.7, 0.08, 0.04));
  box("blue-wall", new Vector3(10, 220, 700), new Vector3(340, 60, 0), new Color3(0.04, 0.15, 0.7));
  box("back-wall", new Vector3(700, 220, 10), new Vector3(0, 60, 340), new Color3(0.16, 0.2, 0.22));
  box("ceiling", new Vector3(700, 5, 700), new Vector3(0, 170, 0), new Color3(0.2, 0.24, 0.3));
  for (let i = 0; i < 5; i++)
    box(`ceiling-light-${i}`, new Vector3(18, 6, 200), new Vector3(-180 + i * 90, 165, 0), new Color3(0.9, 0.9, 0.7));
  box("gold-pillar", new Vector3(35, 160, 35), new Vector3(-100, 50, 180), new Color3(0.9, 0.65, 0.06));
}
let pool: Mesh;
let system: LiquidSurfaceSystem | undefined;
let actorRenderer: import("../../client/RemotePlayerRenderer").RemotePlayerRenderer | undefined;
let selfPose: import("../../../../engine/network/client/SnapshotBuffer").InterpolatedEntity | null = null;
if (mapName) {
  const { GamePaths } = await import("../../../../engine/core/GamePaths");
  const { PK3Index } = await import("../../../../engine/loader/pk3/PK3Index");
  const { MapLoader } = await import("../../../../engine/loader/map/MapLoader");
  await GamePaths.getInstance().init();
  await PK3Index.getInstance().ensureIndex();
  // Stock comparison must leave legacy BSP geometry intact until its adapter is installed.
  RenderVars.getInstance().getVar("r_water")!.value = stock ? 0 : 1;
  const result = await MapLoader.getInstance().loadMap(mapName, scene, undefined, { backgroundOnly: !fullLoad });
  if (!result.success) throw new Error(result.error);
  system = (MapLoader.getInstance() as unknown as { liquidSurfaces: LiquidSurfaceSystem }).liquidSurfaces;
  pool = scene.meshes.find((m) => m.metadata?.liquidKind === "water") as Mesh;
  if (!pool) throw new Error(`No water surface in ${mapName}`);
  pool.computeWorldMatrix(true);
  const bounds = pool.getBoundingInfo().boundingBox;
  const centre = bounds.centerWorld;
  camera.position.copyFrom(centre.add(new Vector3(40, 65, -65)));
  camera.setTarget(centre.add(new Vector3(0, 0, 45)));
  weapon.position.copyFrom(camera.position);
  weapon.rotation.copyFrom(camera.rotation);
} else {
  pool = CreateGround("pool", { width: 360, height: 300, subdivisions: 4 }, scene);
  pool.parent = root;
  pool.metadata = { liquidKind: "water", liquidProfile: "clear" };
  pool.material = new StandardMaterial("legacy", scene);
  system = new LiquidSurfaceSystem(scene);
  system.mapLights = waterMapLights([{ classname: "light", properties: { origin: "0 150 150", light: "500", range: "700" } }]);
  if (!stock) {
    system.claim(root);
  }
}
if (stock) {
  const { WaterMaterial } = await import("@babylonjs/materials/water/waterMaterial");
  const { RawTexture } = await import("@babylonjs/core/Materials/Textures/rawTexture");
  const { VertexBuffer } = await import("@babylonjs/core/Buffers/buffer");
  const { generateWaterNormalMap, WATER_NOISE_SIZE } = await import("../../../../engine/rendering/water/WaterNoise");
  // Stock WaterMaterial uses the mesh origin for its clip plane. BSP positions
  // are baked in world space: rebase without changing any rendered triangle.
  const positions = Array.from(pool.getVerticesData(VertexBuffer.PositionKind)!);
  const height = pool.getBoundingInfo().boundingBox.centerWorld.y;
  for (let i = 1; i < positions.length; i += 3) positions[i] -= height;
  pool.setVerticesData(VertexBuffer.PositionKind, positions);
  pool.position.y += height;
  pool.computeWorldMatrix(true);
  const water = new WaterMaterial("stock-water", scene, new Vector2(512, 512));
  water.bumpTexture = RawTexture.CreateRGBATexture(
    generateWaterNormalMap(),
    WATER_NOISE_SIZE,
    WATER_NOISE_SIZE,
    scene,
    true,
    false,
  );
  water.waveHeight = 0;
  water.bumpHeight = 0.12;
  water.windForce = 2;
  water.bumpSuperimpose = true;
  water.bumpAffectsReflection = true;
  water.fresnelSeparate = true;
  water.waterColor = new Color3(0.08, 0.22, 0.28);
  water.colorBlendFactor = 0.15;
  water.colorBlendFactor2 = 0.05;
  for (const mesh of scene.meshes) {
    if (mesh !== pool && mesh.getTotalVertices() && !mesh.metadata?.liquidKind && !(mesh.layerMask & 0x10000000))
      water.addToRenderList(mesh);
  }
  water.reflectionTexture!.activeCamera = camera;
  water.refractionTexture!.activeCamera = camera;
  pool.material = water;
}
RenderVars.getInstance().getVar("r_water_quality")!.value = 3;
// Exercise the actual gameplay emitter, with real BSP contents in --full mode.
const interactions = new LiquidInteractionSystem(scene);
if (params.has("spray") && !interactions.enableCrowns()) throw new Error("Splash spray unavailable");
const collision = getCollisionManager();
if (fullLoad && collision.isInitialized()) {
  interactions.setCollisionWorld(createBSPCollisionWorld());
}
function gameplaySplash(speed = -400) {
  const bounds = pool.getBoundingInfo().boundingBox;
  let position = bounds.centerWorld.clone();
  if (fullLoad && collision.isInitialized()) {
    // A BSP water mesh can extend underneath solid islands. Find actual liquid,
    // not merely the bounding-box centre used by the synthetic injection.
    const candidates: Vector3[] = [];
    for (let x = bounds.minimumWorld.x + 16; x < bounds.maximumWorld.x; x += 16) {
      for (let z = bounds.minimumWorld.z + 16; z < bounds.maximumWorld.z; z += 16) {
        const p = new Vector3(x, bounds.centerWorld.y - 4, z);
        if (collision.pointContents(p) & ContentFlags.WATER) candidates.push(p);
      }
    }
    candidates.sort((a, b) => Vector3.DistanceSquared(a, bounds.centerWorld) - Vector3.DistanceSquared(b, bounds.centerWorld));
    if (!candidates.length) throw new Error("No swimmable water under the rendered pool");
    position = candidates[0];
  }
  position.y = bounds.centerWorld.y + 16;
  interactions.notify("check", 0, "water", position, speed, true);
  interactions.notify("check", 2, "water", position, speed, true);
  interactions.forget("check");
  return { position: position.asArray(), impulses: waterDisturbancesFor(scene).impulses, rings: interactions.activeRings };
}
if (fullLoad) engine.stopRenderLoop(loadingRender);
let frames = 0;
let transient: PointLight | undefined;
let freezeWaves = false;
pool.material!.onBindObservable.add(() => {
  if (freezeWaves) (pool.material as import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial).getEffect().setFloat("uTime", 8);
});
const instrumentation = new SceneInstrumentation(scene);
const frameSamples: Array<{ cpuMs: number; drawCalls: number }> = [];
engine.runRenderLoop(() => {
  const start = performance.now();
  if (selfPose) actorRenderer?.syncLocalWaterReflection(waterNeedsLocalReflection(scene) ? selfPose : null);
  scene.render();
  frames++;
  frameSamples.push({ cpuMs: performance.now() - start, drawCalls: instrumentation.drawCallsCounter.current });
  if (frameSamples.length > 120) frameSamples.shift();
});
Object.assign(window, {
  waterCheck: {
    selfSetup: async () => {
      const { RemotePlayerRenderer } = await import("../../client/RemotePlayerRenderer");
      actorRenderer = new RemotePlayerRenderer(scene);
      const centre = pool.getBoundingInfo().boundingBox.centerWorld;
      const origin = centre.add(new Vector3(40, 16, -65));
      selfPose = { x: origin.x, y: origin.y, z: origin.z, yaw: 0, vx: 0, vy: 0, vz: 0,
        grounded: true, crouching: false, sliding: false, wallJumping: false, waterLevel: 1 };
      camera.position.copyFrom(origin.add(new Vector3(0, 34, 0)));
      camera.setTarget(new Vector3(origin.x, centre.y, origin.z + 2));
      RenderVars.getInstance().getVar("r_water_actors")!.value = 1;
      freezeWaves = true;
    },
    selfEnabled: (enabled: boolean) => { RenderVars.getInstance().getVar("r_water_actors")!.value = enabled ? 1 : 0; },
    selfState: () => {
      const meshes = scene.meshes.filter(m => isReflectionOnlyActor(m) && m.getTotalVertices());
      return { status: waterActorReflectionStatus(scene), meshes: meshes.map(m => ({ name: m.name, visible: m.isVisible, enabled: m.isEnabled() })) };
    },
    actorSetup: () => {
      const centre = pool.getBoundingInfo().boundingBox.centerWorld;
      camera.position.copyFrom(centre.add(mapName ? new Vector3(40, 65, -65) : new Vector3(0, 55, -130)));
      camera.setTarget(centre.add(new Vector3(0, 5, 0)));
      const actor = box("reflection-test-actor", new Vector3(25, 64, 18), centre.add(new Vector3(0, 52, 30)), new Color3(0.9, 0.08, 0.03));
      actor.parent = null;
      actor.metadata = { waterReflectionActorId: "test-actor" };
      actor.renderingGroupId = 1;
      const head = box("reflection-test-head", new Vector3(17, 14, 17), new Vector3(0, 36, 0), new Color3(0.1, 0.95, 0.12));
      head.parent = actor;
      const blocker = box("reflection-test-blocker", new Vector3(160, 240, 8), centre.add(new Vector3(0, 100, 18)), new Color3(0.15, 0.15, 0.15));
      // Register an extra diagnostic blocker without changing production discovery.
      const provider = (system as unknown as { actorReflection: import("../../../../engine/rendering/water/WaterActorReflection").WaterActorReflection }).actorReflection;
      provider.claim(blocker);
      blocker.setEnabled(false);
      RenderVars.getInstance().getVar("r_water_actors")!.value = 1;
      freezeWaves = true;
    },
    actorMode: (mode: string) => {
      RenderVars.getInstance().getVar("r_water_actors")!.value = mode === "off" ? 0 : 1;
      scene.getMeshByName("reflection-test-blocker")!.setEnabled(mode === "blocked" || mode === "player-blocked");
      scene.getMeshByName("reflection-test-actor")!.setEnabled(mode !== "empty" && mode !== "player-blocked");
    },
    actorPlayer: async () => {
      const { RemotePlayerRenderer } = await import("../../client/RemotePlayerRenderer");
      actorRenderer = new RemotePlayerRenderer(scene);
      scene.getMeshByName("reflection-test-actor")!.setEnabled(false);
      scene.getMeshByName("reflection-test-blocker")!.setEnabled(false);
      const centre = pool.getBoundingInfo().boundingBox.centerWorld;
      // Elevated model: every reflected ray hits the test wall ABOVE the water
      // clip plane. Low feet can legitimately reflect from water behind a bank.
      const model = await actorRenderer.createDetachedModelAtAsync("water-test-player", centre.x, centre.y + 88, centre.z + 60, Math.PI);
      if (!model) throw new Error("Failed to create the real player model");
      RenderVars.getInstance().getVar("r_water_actors")!.value = 1;
      return { tag: model.anchor.metadata?.waterReflectionActorId, skeleton: !!model.skeleton };
    },
    actorState: async () => {
      const target = scene.textures.find(t => t.name === "water-actor-reflection") as import("@babylonjs/core/Materials/Textures/mirrorTexture").MirrorTexture;
      const effect = (pool.material as import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial).getEffect();
      const gl = canvas.getContext("webgl2")!;
      const program = (effect.getPipelineContext() as { program: WebGLProgram }).program;
      const pixels = target ? Array.from(await target.readPixels() as Uint8Array) : [];
      return { active: camera.customRenderTargets.includes(target),
        bound: gl.getUniform(program, gl.getUniformLocation(program, "uHasActorReflection")),
        size: target?.getSize(), pixels,
        list: target?.renderList?.map(m => m.name),
        metrics: { cpuMs: frameSamples.reduce((sum, f) => sum + f.cpuMs, 0) / Math.max(1, frameSamples.length),
          draws: frameSamples.reduce((sum, f) => sum + f.drawCalls, 0) / Math.max(1, frameSamples.length) } };
    },
    state: () => ({
      frames,
      map: mapName,
      renderer: stock ? "stock" : "cached",
      material: pool.material?.name,
      ready: pool.material?.isReady(pool),
      probes: scene.reflectionProbes?.length ?? 0,
      sceneTargets: scene.customRenderTargets.length,
      probePositions: scene.reflectionProbes?.map((probe) => probe.position.asArray()),
      cameraTargets: camera.customRenderTargets.length,
      colourCapture: camera.customRenderTargets.find(t => t.name === "water-scene-colour")?.getSize(),
      webgl: engine.webGLVersion,
      hardware: engine.getGlInfo(),
      bounds: {
        min: pool.getBoundingInfo().boundingBox.minimumWorld.asArray(),
        max: pool.getBoundingInfo().boundingBox.maximumWorld.asArray(),
      },
    }),
    debug: (mode: number) => {
      RenderVars.getInstance().getVar("r_water_debug")!.value = mode;
    },
    hideWater: (hide: boolean) => { pool.isVisible = !hide; },
    ripple: () => waterDisturbancesFor(scene).add(pool.getBoundingInfo().boundingBox.centerWorld, 1, 120),
    gameplaySplash,
    gameplayWake: async () => {
      const splash = gameplaySplash();
      const [x, y, z] = splash.position;
      interactions.notify("wake-check", 2, "water", { x, y, z }, 0, true);
      for (let i = 1; i <= 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 80));
        interactions.notify("wake-check", 2, "water", { x: x + i * 8, y, z }, 0, true);
      }
      interactions.forget("wake-check");
    },
    tune: (reflection: number, highlights: number) => {
      RenderVars.getInstance().getVar("r_water_reflection")!.value = reflection;
      RenderVars.getInstance().getVar("r_water_highlights")!.value = highlights;
    },
    freezeWaves: (freeze: boolean) => { freezeWaves = freeze; },
    polish: (blur = 0.3, detail = 0.8, contact = 0.25) => {
      RenderVars.getInstance().getVar("r_water_blur")!.value = blur;
      RenderVars.getInstance().getVar("r_water_detail")!.value = detail;
      RenderVars.getInstance().getVar("r_water_contact")!.value = contact;
    },
    polishView: (index: number) => {
      const centre = pool.getBoundingInfo().boundingBox.centerWorld;
      const offsets = [new Vector3(40, 85, 155), new Vector3(-140, 65, 80), new Vector3(130, 25, 90)];
      camera.position.copyFrom(centre.add(offsets[index]));
      camera.setTarget(centre.add(new Vector3(0, 0, -40)));
      weapon.position.copyFrom(camera.position);
      weapon.rotation.copyFrom(camera.rotation);
    },
    reflectionAudit: async () => {
      const probe = scene.reflectionProbes?.[0];
      if (!probe) throw new Error("Missing reflection probe");
      const cube = probe.cubeTexture;
      const faces = [];
      for (let face = 0; face < 6; face++) faces.push(Array.from(await cube.readPixels(face) as Uint8Array));
      const effect = (pool.material as import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial).getEffect();
      const gl = canvas.getContext("webgl2")!;
      const program = (effect.getPipelineContext() as { program: WebGLProgram }).program;
      const read = (name: string) => Array.from(gl.getUniform(program, gl.getUniformLocation(program, name)) ?? []);
      return { size: cube.getSize(), gamma: cube.gammaSpace, faces,
        position: probe.position.asArray(), min: read("uProbeMin"), max: read("uProbeMax") };
    },
    raiseProbe: (height: number) => {
      const probe = scene.reflectionProbes?.[0];
      if (!probe) throw new Error("Missing reflection probe");
      const list = probe.renderList ?? [];
      const visible = list.map(mesh => mesh.isVisible);
      try {
        list.forEach(mesh => { mesh.isVisible = true; });
        probe.position.y += height;
        probe.cubeTexture.render(false);
      } finally { list.forEach((mesh, i) => { mesh.isVisible = visible[i]; }); }
    },
    transientLight: (enabled = true) => {
      transient?.dispose(); transient = undefined;
      if (enabled) {
        transient = new PointLight("test-muzzle-light", camera.position.clone(), scene);
        transient.intensity = 100;
        transient.metadata = { excludeFromWaterCapture: true };
      }
    },
    lightingState: () => {
      const effect = (pool.material as import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial).getEffect();
      const gl = canvas.getContext("webgl2")!;
      const program = (effect.getPipelineContext() as { program: WebGLProgram }).program;
      const read = (name: string) => gl.getUniform(program, gl.getUniformLocation(program, name));
      return { lights: Array.from({ length: 4 }, (_, i) => Array.from(read(`uWaterLights[${i}]`) ?? [])).flat(),
        colours: Array.from({ length: 4 }, (_, i) => Array.from(read(`uWaterLightColours[${i}]`) ?? [])).flat(),
        reflection: read("uReflectionStrength"), highlights: read("uHighlightStrength"),
        blur: read("uReflectionBlur"), detail: read("uDetailStrength"), contact: read("uContactStrength"),
        masks: scene.textures.filter(t => t.name === "water-static-light-visibility").length,
        maskSums: scene.textures.filter(t => t.name === "water-static-light-visibility").map(t => {
          const bytes = t.getInternalTexture()?._bufferView as Uint8Array | undefined;
          const sums = [0, 0, 0, 0];
          bytes?.forEach((v, i) => { sums[i % 4] += v; });
          return sums;
        }) };
    },
    sprayState: () => {
      const mesh = scene.getMeshByName("liquid-splash-droplets");
      return { count: interactions.activeDroplets, material: mesh?.material?.name,
        enabled: mesh?.isEnabled(), ready: mesh?.material?.isReady(mesh),
        indices: mesh?.subMeshes?.[0]?.indexCount, effectOwned: mesh?.metadata?.effectOwned };
    },
    impulses: () => {
      const effect = (pool.material as import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial).getEffect();
      const gl = canvas.getContext("webgl2")!;
      const program = (effect.getPipelineContext() as { program: WebGLProgram }).program;
      const gpu = Array.from({ length: 24 }, (_, i) =>
        Array.from(gl.getUniform(program, gl.getUniformLocation(program, `uImpulses[${i}]`)) as Float32Array)).flat();
      return { cpu: waterDisturbancesFor(scene).impulses, gpu, rings: interactions.activeRings };
    },
    quality: (quality: number) => {
      RenderVars.getInstance().getVar("r_water_quality")!.value = quality;
      frameSamples.length = 0;
    },
    metrics: () => ({
      frames: frameSamples.length,
      cpuMs: frameSamples.reduce((sum, frame) => sum + frame.cpuMs, 0) / Math.max(1, frameSamples.length),
      drawCalls: frameSamples.reduce((sum, frame) => sum + frame.drawCalls, 0) / Math.max(1, frameSamples.length),
      cameraTargets: camera.customRenderTargets.length,
    }),
    view: (view: string) => {
      const centre = pool.getBoundingInfo().boundingBox.centerWorld;
      const offset = view === "underwater" ? new Vector3(40, -12, -65) : new Vector3(40, 20, 65);
      camera.position.copyFrom(centre.add(offset));
      camera.setTarget(centre.add(new Vector3(0, view === "underwater" ? 25 : 0, -70)));
      weapon.position.copyFrom(camera.position);
      weapon.rotation.copyFrom(camera.rotation);
    },
    dispose: () => {
      interactions.dispose();
      system?.dispose();
      scene.dispose();
      engine.dispose();
    },
  },
});
