/** Run after headless regressions. Real WebGL via a disposable headless Chrome session. */
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const browser = process.env.WATER_CHECK_BROWSER ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const map = process.argv.find((a) => a.startsWith("--map="))?.slice(6);
const stock = process.argv.includes("--stock");
const fullLoad = process.argv.includes("--full");
const app = process.argv.includes("--app");
const postprocess = process.argv.includes("--postprocess");
const spray = process.argv.includes("--spray");
const lighting = process.argv.includes("--lighting");
const reflectionAudit = process.argv.includes("--reflection-audit");
const contactPolish = process.argv.includes("--contact-polish");
const interactionCheck = process.argv.includes("--interactions");
const actorCheck = process.argv.includes("--actors");
const selfCheck = process.argv.includes("--self-reflection");
const polish = process.argv.includes("--polish") || contactPolish;
const probeHeight = Number(process.argv.find(a => a.startsWith("--probe-height="))?.split("=")[1] ?? 0);
const output = resolve(`temp/water-visual-check${map ? `-${map}` : ""}${stock ? "-stock" : ""}${fullLoad ? "-full" : ""}${app ? "-app" : ""}${postprocess ? "-postprocess" : ""}${spray ? "-spray" : ""}${lighting ? "-lighting" : ""}${reflectionAudit ? "-reflection" : ""}${probeHeight ? `-height${probeHeight}` : ""}${polish ? "-polish" : ""}${contactPolish ? "-contact" : ""}${interactionCheck ? "-interactions" : ""}${actorCheck ? "-actors" : ""}${selfCheck ? "-self" : ""}`);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "shag-water-check-"));
const server = await createServer({
  // This fixture changes optimizeDeps (stock material comparison). Never
  // rewrite a simultaneously running developer server's dependency cache.
  cacheDir: resolve("temp/vite-water-check-cache"),
  optimizeDeps: { include: ["@babylonjs/materials/water/waterMaterial", "@babylonjs/core/PostProcesses/imageProcessingPostProcess", "@babylonjs/core/Maths/math.frustum"] },
  server: { host: "127.0.0.1", port: 3017, strictPort: true },
  plugins: [
    {
      name: "water-check-fixture",
      configureServer(vite) {
        vite.middlewares.use("/__water_check", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(
            '<html><body style="margin:0;overflow:hidden"><canvas width="1100" height="740" style="width:1100px;height:740px"></canvas><script type="module" src="/src/games/fps/scripts/diagnostics/water-visual-scene.ts"></script></body></html>',
          );
        });
      },
    },
  ],
});
let child, ws;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await server.listen();
  child = spawn(
    browser,
    [
      "--headless=new",
      "--remote-debugging-port=9227",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1100,740",
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  child.on("error", (error) => console.error(error));
  let pages;
  for (let i = 0; i < 100; i++) {
    try {
      pages = await (await fetch("http://127.0.0.1:9227/json/list")).json();
      if (pages.length) break;
    } catch {}
    await delay(100);
  }
  if (!pages?.length) throw new Error("Headless browser did not expose its local debugging endpoint");
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  const logs = [];
  ws.on("message", (bytes) => {
    const message = JSON.parse(bytes);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error")
      errors.push(message.params.entry);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error")
      errors.push(message.params.args);
    if (message.method === "Runtime.consoleAPICalled") logs.push(message.params.args.map(a => a.value ?? a.description).join(" "));
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      const timeout = setTimeout(() => {
        pending.delete(next);
        reject(new Error(`Timeout: ${method}`));
      }, 60000);
      pending.set(next, (message) => {
        clearTimeout(timeout);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1100, height: 740, deviceScaleFactor: 1, mobile: false });
  if (app) {
    await call("Page.navigate", { url: "http://127.0.0.1:3017/" });
    for (let i = 0; i < 240; i++) {
      if (await evaluate("!!window.scene")) break;
      await evaluate("document.querySelector('.ui-loading-screen--ready')?.click()");
      await delay(250);
    }
    if (!(await evaluate("!!window.scene"))) throw new Error("Application did not reach lobby");
    await evaluate("import('/src/engine/rendering/RenderVars.ts').then(({default: vars}) => { vars.getInstance().getVar('r_water_quality').value = 3; })");
    await evaluate(`window.appMapLoad = { done: false }; import('/src/engine/loader/map/MapLoader.ts').then(({MapLoader}) => MapLoader.getInstance().loadMap(${JSON.stringify(map ?? "acidwdm2")}, window.scene)).then(result => window.appMapLoad = {done: true, result: {success:result.success,error:result.error}}).catch(error => window.appMapLoad = {done: true, error: String(error)}) ; true`);
    let state;
    for (let i = 0; i < 240; i++) {
      state = await evaluate("({load: window.appMapLoad, ready: window.scene.isReady(), probes: window.scene.reflectionProbes?.length, failed: window.scene.meshes.flatMap(mesh => (mesh.subMeshes ?? []).filter(sub => sub.effect?.getCompilationError()).map(sub => ({mesh:mesh.name,error:sub.effect.getCompilationError(),vertex:sub.effect.getVertexShaderSource(),fragment:sub.effect.getFragmentShaderSource()})))})");
      if (state.failed.length || state.load.done) break;
      await delay(250);
    }
    await writeFile(join(output, "readiness.json"), JSON.stringify({ state, errors, logs }, null, 2));
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "app.png"), Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({load: state.load, ready: state.ready, probes: state.probes, failed: state.failed.map(f => ({mesh: f.mesh, error:f.error, vertexLength:f.vertex.length,fragmentLength:f.fragment.length})), lastLogs:logs.slice(-8)}, null, 2));
    if (!state.ready || !state.load.done || !state.load.result?.success || state.failed.length) throw new Error("Application map readiness failed");
  } else {
  const query = new URLSearchParams({ ...(map ? { map } : {}), ...(stock ? { renderer: "stock" } : {}), ...(fullLoad ? { full: "1" } : {}), ...(postprocess ? {postprocess:"1"} : {}), ...(spray ? {spray:"1"} : {}) });
  await call("Page.navigate", { url: `http://127.0.0.1:3017/__water_check?${query}` });
  let state;
  for (let i = 0; i < 480; i++) {
    state = await evaluate("window.waterCheck?.state()");
    if (state?.frames > 20 && state.ready && (stock || state.probes)) break;
    if (errors.length > 30 || errors.some(error => error.exception)) break;
    await delay(250);
  }
  await writeFile(join(output, "readiness.json"), JSON.stringify({ state, errors }, null, 2));
  console.log(JSON.stringify({ state, errorCount: errors.length, firstErrors: errors.slice(0, 3) }, null, 2));
  if (
    !state?.ready ||
    !(stock ? state.material === "stock-water" : state.material?.startsWith("unified-water") && state.probes) ||
    errors.some((e) => !e.url?.includes("favicon.ico"))
  )
    throw new Error("Water fixture failed GPU validation");
  if (probeHeight) await evaluate(`window.waterCheck.raiseProbe(${probeHeight})`);
  if (selfCheck) {
    const { PNG } = await import("pngjs");
    await evaluate("window.waterCheck.selfSetup()");
    for (let i = 0; i < 120; i++) {
      const self = await evaluate("window.waterCheck.selfState()");
      if (self.meshes.length && self.status.includes("captured")) break;
      await delay(250);
    }
    await delay(1500);
    const on = await evaluate("window.waterCheck.selfState()");
    const capture = await evaluate("window.waterCheck.actorState()");
    const covered = capture.pixels.filter((p, i) => i % 4 === 3 && p > 16).length;
    const enabledShot = Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64");
    await writeFile(join(output, "self-on.png"), enabledShot);
    await evaluate("window.waterCheck.selfEnabled(false)");
    await delay(1500);
    const off = await evaluate("window.waterCheck.selfState()");
    const disabledShot = Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64");
    await writeFile(join(output, "self-off.png"), disabledShot);
    const a = PNG.sync.read(enabledShot), b = PNG.sync.read(disabledShot);
    const changed = a.data.filter((v, i) => i % 4 !== 3 && Math.abs(v - b.data[i]) > 3).length;
    await writeFile(join(output, "self.json"), JSON.stringify({ on, off, covered, changed, errors }, null, 2));
    if (!capture.active || capture.bound !== 1 || !on.meshes.length || on.meshes.some(m => m.visible) ||
        off.meshes.some(m => m.visible || m.enabled) || covered < 20 || changed < 30)
      throw new Error("Local-only reflection is absent or leaked into normal rendering");
  }
  if (actorCheck) {
    const { PNG } = await import("pngjs");
    await evaluate("window.waterCheck.actorSetup()");
    const results = {};
    const actorShots = {};
    for (const mode of ["on", "off", "blocked", "empty"]) {
      await evaluate(`window.waterCheck.actorMode('${mode}')`);
      await delay(2500);
      const result = await evaluate("window.waterCheck.actorState()");
      if (result.pixels.length) {
        result.coveredPixels = result.pixels.filter((p, i) => i % 4 === 3 && p > 16).length;
        const png = new PNG({ ...result.size });
        for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
          const src = ((png.height - 1 - y) * png.width + x) * 4, dst = (y * png.width + x) * 4;
          for (let c = 0; c < 3; c++) png.data[dst + c] = result.pixels[src + c];
          png.data[dst + 3] = 255;
        }
        await writeFile(join(output, `actor-${mode}-capture.png`), PNG.sync.write(png));
      }
      delete result.pixels;
      results[mode] = result;
      const shot = await call("Page.captureScreenshot", { format: "png" });
      actorShots[mode] = PNG.sync.read(Buffer.from(shot.data, "base64"));
      await writeFile(join(output, `actor-${mode}.png`), Buffer.from(shot.data, "base64"));
    }
    const changedPixels = actorShots.on.data.filter((value, i) => i % 4 !== 3 && Math.abs(value - actorShots.off.data[i]) > 3).length;
    if (changedPixels < 30) throw new Error("Actor capture did not change the visible water surface");
    await writeFile(join(output, "actors.json"), JSON.stringify({ results, errors }, null, 2));
    console.log(JSON.stringify({ actors: results }, null, 2));
    if (!results.on.active || results.on.bound !== 1 || results.on.coveredPixels < 20 ||
        results.blocked.coveredPixels !== 0 || results.off.active || results.empty.active) {
      throw new Error("Actor overlay or reflected-view occlusion failed");
    }
    const player = await evaluate("window.waterCheck.actorPlayer()");
    await delay(2500);
    const playerState = await evaluate("window.waterCheck.actorState()");
    playerState.coveredPixels = playerState.pixels.filter((p, i) => i % 4 === 3 && p > 16).length;
    delete playerState.pixels;
    await writeFile(join(output, "actor-player.json"), JSON.stringify({ player, playerState, errors }, null, 2));
    const playerShot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "actor-player.png"), Buffer.from(playerShot.data, "base64"));
    if (!player.skeleton || !playerState.active || playerState.bound !== 1 || playerState.coveredPixels < 20)
      throw new Error("Real player model missing from actor reflection");
    await evaluate("window.waterCheck.actorMode('player-blocked')");
    await delay(1000);
    const blockedPlayer = await evaluate("window.waterCheck.actorState()");
    const blockedPng = new PNG({ ...blockedPlayer.size });
    for (let y = 0; y < blockedPng.height; y++) for (let x = 0; x < blockedPng.width; x++) {
      const src = ((blockedPng.height - 1 - y) * blockedPng.width + x) * 4, dst = (y * blockedPng.width + x) * 4;
      for (let c = 0; c < 3; c++) blockedPng.data[dst + c] = blockedPlayer.pixels[src + c];
      blockedPng.data[dst + 3] = 255;
    }
    await writeFile(join(output, "actor-player-blocked-capture.png"), PNG.sync.write(blockedPng));
    const blockedPlayerPixels = blockedPlayer.pixels.filter((p, i) => i % 4 === 3 && p > 16).length;
    await writeFile(join(output, "actor-player-occlusion.json"), JSON.stringify({ blockedPlayerPixels, changedPixels, errors }, null, 2));
    if (blockedPlayerPixels !== 0) throw new Error("Real player model leaked through reflection occluder");
    await evaluate("window.waterCheck.actorMode('off')");
  }
  if (reflectionAudit) {
    const audit = await evaluate("window.waterCheck.reflectionAudit()");
    const { PNG } = await import("pngjs");
    const colourPixels = [];
    for (let face = 0; face < 6; face++) {
      const png = new PNG({ width: audit.size.width, height: audit.size.height });
      let coloured = 0;
      for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
        const src = ((png.height - y - 1) * png.width + x) * 4, dst = (y * png.width + x) * 4;
        for (let c = 0; c < 3; c++) png.data[dst + c] = Math.round(255 * Math.pow(audit.faces[face][src + c] / 255, audit.gamma ? 1 : 1 / 2.2));
        png.data[dst + 3] = 255;
        const rgb = Array.from(png.data.subarray(dst, dst + 3));
        if (Math.max(...rgb) - Math.min(...rgb) > 10) coloured++;
      }
      colourPixels.push(coloured);
      await writeFile(join(output, `cube-face-${face}.png`), PNG.sync.write(png));
    }
    delete audit.faces;
    audit.colourPixels = colourPixels;
    audit.captureLog = logs.filter(line => line.includes("Configured lighting for BSP") || line.includes("[Water] Captured"));
    await writeFile(join(output, "reflection-audit.json"), JSON.stringify(audit, null, 2));
    if (map === "acidwdm2") {
      const configured = logs.findIndex(line => line.includes("Configured lighting for BSP"));
      const captured = logs.findIndex(line => line.includes("[Water] Captured"));
      if (configured < 0 || captured <= configured) throw new Error("Water captured before BSP lighting configuration");
      // This map has purple/cyan trim on both X-facing walls. Shader readiness
      // alone used to accept almost black faces: verify actual captured colour.
      if (colourPixels[0] < 100 || colourPixels[1] < 100) throw new Error("Lit map detail missing from water cubemap faces");
    }
  }
  for (const [name, mode] of stock
    ? [["surface", 0]]
    : [
        ["surface", 0],
        ["room", 4],
        ["disturbance", 5],
      ]) {
    await evaluate(`window.waterCheck.debug(${mode}); window.waterCheck.ripple()`);
    await delay(350);
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
  }
  await evaluate("window.waterCheck.debug(0)");
  if (!stock && fullLoad) {
    await delay(2200);
    await evaluate("window.waterCheck.debug(5)");
    const emitted = await evaluate("window.waterCheck.gameplaySplash()");
    await delay(250);
    const bound = await evaluate("window.waterCheck.impulses()");
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "gameplay-disturbance.png"), Buffer.from(shot.data, "base64"));
    await writeFile(join(output, "gameplay-disturbance.json"), JSON.stringify({ emitted, bound, errors }, null, 2));
    console.log(JSON.stringify({ gameplay: { emitted, bound } }, null, 2));
    if (!emitted.impulses.length || bound.gpu[4] <= 0 ||
        Math.abs(bound.gpu[5] - emitted.impulses[0].radius) > 0.001 || bound.rings !== 0) {
      console.error(JSON.stringify(errors.slice(-3), null, 2));
      throw new Error("Gameplay splash did not replace the legacy ring with GPU wave uniforms");
    }
    await delay(700);
    const later = await evaluate("window.waterCheck.impulses()");
    if (later.gpu[3] <= bound.gpu[3] || later.gpu[4] <= 0) throw new Error("Gameplay wave did not advance on the GPU");
    const laterShot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "gameplay-disturbance-later.png"), Buffer.from(laterShot.data, "base64"));
    await writeFile(join(output, "gameplay-disturbance.json"), JSON.stringify({ emitted, bound, later }, null, 2));
    await evaluate("window.waterCheck.debug(0)");
  }
  const metrics = {};
  for (const quality of stock ? [3] : [1, 2, 3]) {
    await evaluate(`window.waterCheck.quality(${quality})`);
    for (let i = 0; i < 120; i++) {
      const sample = await evaluate("window.waterCheck.metrics()");
      if (sample.frames >= 120) {
        metrics[quality] = sample;
        break;
      }
      await delay(100);
    }
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, `quality-${quality}-idle.png`), Buffer.from(shot.data, "base64"));
    if (quality === 3) {
      await delay(700);
      const later = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(join(output, "idle-later.png"), Buffer.from(later.data, "base64"));
    }
  }
  if (!stock && (fullLoad || lighting)) {
    if (spray) {
      await evaluate("window.waterCheck.gameplaySplash()");
      await delay(120);
      const state = await evaluate("window.waterCheck.sprayState()");
      const shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(join(output, "spray.png"), Buffer.from(shot.data, "base64"));
      await writeFile(join(output, "spray.json"), JSON.stringify(state, null, 2));
      if (!state.count || !state.ready || state.indices !== state.count * 6 || !state.effectOwned)
        throw new Error("Actual gameplay spray did not render as batched quads");
      await delay(2200);
    }
    if (lighting) {
      await evaluate("window.waterCheck.freezeWaves(true)");
      const before = await evaluate("window.waterCheck.lightingState()");
      await evaluate("window.waterCheck.transientLight()");
      await delay(100);
      const after = await evaluate("window.waterCheck.lightingState()");
      if (JSON.stringify(before.lights) !== JSON.stringify(after.lights) || JSON.stringify(before.colours) !== JSON.stringify(after.colours))
        throw new Error("Transient light contaminated static water highlight uniforms");
      await evaluate("window.waterCheck.transientLight(false)");
      for (const [name, reflection, highlights] of [["reflection-baseline", 1, 0.6], ["reflection-boost", 1.3, 0.6], ["highlights-off", 1.3, 0]]) {
        await evaluate(`window.waterCheck.tune(${reflection}, ${highlights})`);
        await delay(150);
        const shot = await call("Page.captureScreenshot", { format: "png" });
        await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
      }
      await evaluate("window.waterCheck.tune(1.3, 0.6)");
      await evaluate("window.waterCheck.freezeWaves(false)");
      await evaluate("window.waterCheck.gameplayWake()");
      await delay(100);
      const wake = await evaluate("window.waterCheck.impulses()");
      if (!wake.gpu.some((v, i) => (i % 8 === 6 || i % 8 === 7) && Math.abs(v) > 0.1))
        throw new Error("Directional gameplay wake did not reach GPU");
      const shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(join(output, "directional-wake.png"), Buffer.from(shot.data, "base64"));
      await writeFile(join(output, "lighting.json"), JSON.stringify({ before, after, wake }, null, 2));
      await delay(2200);
    }
    await evaluate("window.waterCheck.debug(6)");
    await delay(150);
    const capture = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "refraction-alignment.png"), Buffer.from(capture.data, "base64"));
    await evaluate("window.waterCheck.hideWater(true)");
    await delay(150);
    const reference = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "refraction-reference.png"), Buffer.from(reference.data, "base64"));
    await evaluate("window.waterCheck.hideWater(false); window.waterCheck.debug(0)");
    await evaluate("window.waterCheck.gameplaySplash()");
    await delay(350);
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "gameplay-beauty.png"), Buffer.from(shot.data, "base64"));
    await delay(550);
    const laterShot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "gameplay-beauty-later.png"), Buffer.from(laterShot.data, "base64"));
  }
  if (polish && !stock) {
    await delay(2200);
    await evaluate("window.waterCheck.debug(0); window.waterCheck.quality(3); window.waterCheck.freezeWaves(true)");
    const { PNG } = await import("pngjs");
    const comparisons = [];
    for (let view = 0; view < 3; view++) {
      await evaluate(`window.waterCheck.polishView(${view})`);
      let baseline;
      for (const [name, blur, detail, contact] of [
        ["default", 0.3, 0.8, 0.25], ["sharp", 0, 0.8, 0.25],
        ["no-contact", 0.3, 0.8, 0], ["broad-only", 0.3, 0, 0.25], ["previous-detail", 0.3, 0.5, 0.25],
      ]) {
        await evaluate(`window.waterCheck.polish(${blur}, ${detail}, ${contact})`);
        await delay(200);
        const shot = await call("Page.captureScreenshot", { format: "png" });
        const bytes = Buffer.from(shot.data, "base64");
        await writeFile(join(output, `polish-${view}-${name}.png`), bytes);
        const pixels = PNG.sync.read(bytes).data;
        if (name === "default") baseline = pixels;
        else {
          let changed = 0, maxDelta = 0, contactBrightening = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const delta = Math.max(...[0, 1, 2].map(c => Math.abs(pixels[i + c] - baseline[i + c])));
            if (delta > 0) changed++;
            maxDelta = Math.max(maxDelta, delta);
            if (name === "no-contact")
              for (let c = 0; c < 3; c++) contactBrightening = Math.max(contactBrightening, baseline[i + c] - pixels[i + c]);
          }
          comparisons.push({ view, name, changed, maxDelta, contactBrightening });
          if (name === "no-contact" && contactBrightening > 1)
            throw new Error("Contact shade added light/colour instead of attenuating the existing water");
        }
      }
    }
    const contactGuards = [];
    for (const [name, quality, underwater] of [["no-depth", 1, false], ["underwater", 3, true], ["medium", 2, false]]) {
      await evaluate(`window.waterCheck.quality(${quality}); ${underwater ? "window.waterCheck.view('underwater')" : "window.waterCheck.polishView(0)"}`);
      const images = [];
      for (const strength of [0, 1]) {
        await evaluate(`window.waterCheck.polish(0.3, 0.8, ${strength})`);
        await delay(200);
        const shot = await call("Page.captureScreenshot", { format: "png" });
        const bytes = Buffer.from(shot.data, "base64");
        images.push(PNG.sync.read(bytes).data);
        await writeFile(join(output, `contact-guard-${name}-${strength}.png`), bytes);
      }
      const identical = images[0].equals(images[1]);
      let brightening = 0;
      for (let i = 0; i < images[0].length; i += 4)
        for (let c = 0; c < 3; c++) brightening = Math.max(brightening, images[1][i + c] - images[0][i + c]);
      contactGuards.push({ name, identical, brightening });
      if (name === "medium") {
        if (brightening > 1) throw new Error("Quality-2 contact shade added light/colour");
      } else if (!identical) throw new Error(`Contact detail changed pixels in ${name} fallback`);
    }
    await evaluate("window.waterCheck.polish(); window.waterCheck.polishView(0); window.waterCheck.quality(3)");
    await delay(100);
    const uniforms = await evaluate("window.waterCheck.lightingState()");
    if (Math.abs(uniforms.blur - 0.3) > 0.001 || Math.abs(uniforms.detail - 0.8) > 0.001 || uniforms.contact !== 0.25)
      throw new Error("Polish controls did not reach the GPU");
    await writeFile(join(output, "polish.json"), JSON.stringify({ comparisons, uniforms, contactGuards }, null, 2));
    if (!["sharp", "broad-only"].every(name => comparisons.some(c => c.name === name && c.changed > 100)))
      throw new Error("Reflection/detail controls produced no visible normal-mode difference");
    if (map === "acidwdm2" && !comparisons.some(c => c.name === "no-contact" && c.changed > 0 && c.changed < 5000))
      throw new Error("Contact detail missing or not confined to a narrow bank region");
    await evaluate("window.waterCheck.freezeWaves(false)");
  }
  if (interactionCheck && fullLoad && !stock) {
    const impacts = [];
    await evaluate("window.waterCheck.debug(0)");
    for (const [name, speed] of [["light", -100], ["hard", -700]]) {
      await delay(2300);
      const emitted = await evaluate(`window.waterCheck.gameplaySplash(${speed})`);
      await delay(80);
      const sprayState = await evaluate("window.waterCheck.sprayState()");
      impacts.push({ name, emitted, sprayState });
      for (const [phase, wait] of [["early", 0], ["spread", 300], ["settle", 600]]) {
        if (wait) await delay(wait);
        const shot = await call("Page.captureScreenshot", { format: "png" });
        await writeFile(join(output, `impact-${name}-${phase}.png`), Buffer.from(shot.data, "base64"));
      }
    }
    const first = impacts[0].emitted.impulses[0], second = impacts[1].emitted.impulses[0];
    if (!first || !second || second.strength <= first.strength || second.radius <= first.radius)
      throw new Error("Hard impacts did not produce stronger/wider surface disturbances");
    if (spray && impacts[1].sprayState.count <= impacts[0].sprayState.count)
      throw new Error("Hard impacts did not produce more spray than light impacts");
    await delay(2300);
    const settled = await evaluate("window.waterCheck.impulses()");
    if (settled.cpu.length || settled.rings) throw new Error("Impact effects failed to settle");
    await writeFile(join(output, "interactions.json"), JSON.stringify({ impacts, settled }, null, 2));
  }
  for (const name of ["grazing", "underwater"]) {
    await evaluate(`window.waterCheck.view('${name}')`);
    await delay(350);
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
  }
  await writeFile(join(output, "result.json"), JSON.stringify({ state, metrics, errors }, null, 2));
  console.log(JSON.stringify({ metrics }, null, 2));
  if (errors.some((e) => !e.url?.includes("favicon.ico"))) throw new Error("GPU errors during visual capture");
  console.log(`Screenshots: ${output}`);
  }
} finally {
  ws?.close();
  child?.kill();
  await server.close();
  // The isolated browser profile is left in the OS temp directory for diagnostics.
}
