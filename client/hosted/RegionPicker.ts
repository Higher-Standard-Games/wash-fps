/**
 * The region picker a hosted build shows before anything else: washoi.net's
 * /play launcher (`RegionLauncher.tsx`, `RegionMap.tsx`, `region-map.css`),
 * which the native client draws too.
 *
 * The world as a dot matrix, a pin and a label per region with its address,
 * whether it is online, its ping and the nearest one marked, and a Launch key.
 * The region the player picks is remembered and wins next time, as the site's
 * `washoi.region` does. The labels are the controls: buttons laid over the
 * map, so they stay crisp and keyboard-reachable.
 *
 * The region supplies the lobby and the game data, so nothing loads before
 * the player launches. Launch is also the click the browser needs before the
 * game may play sound or go fullscreen.
 */

import { background } from "../../../../engine/core/AsyncErrors";
import { raiseKey, setRaisedKeyText } from "../../../../engine/ui/components/RaisedKey";
import { button, el } from "../settings/SettingsFields";
import { type PingResult, pingLobby } from "./RegionPing";
import { guessRegion, type Region, storedPick, storePick } from "./Regions";
import { toGrid, WORLD_DOTS } from "./WorldDots";
import "./RegionPicker.css";

type PingState = PingResult | { status: "measuring" };

const SVG = "http://www.w3.org/2000/svg";
const COLS = WORLD_DOTS.rows[0].length;
const ROWS = WORLD_DOTS.rows.length;
/** Dot size inside its 1×1 cell. Square, not round: it reads as a HUD grid. */
const DOT = 0.52;
const PAD = (1 - DOT) / 2;
/** Radius, in cells, of the lit patch of land around a region's pin. */
const GLOW_RADIUS = 11;

type Dot = { x: number; y: number };

const LAND: Dot[] = WORLD_DOTS.rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === "1" ? [{ x, y }] : [])));

function dotsPath(dots: readonly Dot[]): string {
  return dots.map(({ x, y }) => `M${x + PAD} ${y + PAD}h${DOT}v${DOT}h-${DOT}z`).join("");
}

/** Land dots near a pin, in three bands by distance, so the glow fades out. */
function glowBands(pin: Dot): string[] {
  const bands: Dot[][] = [[], [], []];
  for (const dot of LAND) {
    const distance = Math.hypot(dot.x + 0.5 - pin.x, dot.y + 0.5 - pin.y);
    if (distance > GLOW_RADIUS) continue;
    bands[Math.min(2, Math.floor((distance / GLOW_RADIUS) * 3))].push(dot);
  }
  return bands.map(dotsPath);
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/** The fastest region that answered, or the time zone's guess while none has. */
export function nearestRegion(
  regions: readonly Region[],
  pings: ReadonlyMap<string, PingState>,
  guessed: Region,
): Region {
  let best: Region | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const region of regions) {
    const ping = pings.get(region.id);
    if (ping?.status === "ok" && ping.ms < bestMs) {
      best = region;
      bestMs = ping.ms;
    }
  }
  return best ?? guessed;
}

function pingText(ping: PingState | undefined): string {
  if (ping?.status === "ok") return `${ping.ms} ms`;
  if (ping?.status === "unreachable") return "No reply";
  return "…";
}

/** The dot-matrix world with a glow, rings and a label per region. */
function buildMap(regions: readonly Region[], select: (region: Region) => void) {
  const map = el("div", "region-map");
  const world = svg("svg", { viewBox: `0 0 ${COLS} ${ROWS}`, class: "region-map__world", "aria-hidden": "true" });
  world.append(svg("path", { d: dotsPath(LAND), class: "region-map__land" }));
  const pins = regions.map((region) => ({ region, ...toGrid(region.pin.lon, region.pin.lat) }));

  const glows = pins.map((pin) => {
    const glow = svg("g", { class: "region-map__glow" });
    glowBands(pin).forEach((d, band) => {
      glow.append(svg("path", { d, style: `opacity: ${[1, 0.6, 0.28][band]}` }));
    });
    world.append(glow);
    return glow;
  });

  // The link between the first two regions: a shallow arc under the markers
  if (pins.length >= 2) {
    const [a, b] = pins;
    const mx = (a.x + b.x) / 2;
    const my = Math.min(a.y, b.y) - Math.abs(a.x - b.x) * 0.18;
    world.append(svg("path", { d: `M${a.x} ${a.y}Q${mx} ${my} ${b.x} ${b.y}`, class: "region-map__link" }));
  }

  const markers = pins.map((pin) => {
    const marker = svg("g", { class: "region-map__pin" });
    marker.append(
      svg("circle", { cx: pin.x, cy: pin.y, r: 1.6, class: "region-map__ring" }),
      svg("circle", { cx: pin.x, cy: pin.y, r: 1.6, class: "region-map__ring region-map__ring--late" }),
      svg("circle", { cx: pin.x, cy: pin.y, r: 0.9, class: "region-map__core" }),
    );
    world.append(marker);
    return marker;
  });

  const group = el("div");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Server region");
  const labels = pins.map((pin) => {
    const { region } = pin;
    const label = button(`region-map__label${region.labelSide === "below" ? " region-map__label--below" : ""}`);
    label.setAttribute("role", "radio");
    label.dataset.region = region.id;
    label.style.left = `${(pin.x / COLS) * 100}%`;
    label.style.top = `${(pin.y / ROWS) * 100}%`;
    const meta = el("span", "region-map__meta");
    const stats = el("span", "region-map__stats");
    const ping = el("span", "", "…");
    const nearest = el("span", "region-map__nearest", "Nearest");
    stats.append(el("span", "region-map__live", "Online"), ping, nearest);
    meta.append(el("span", "region-map__name", region.name), el("span", "region-map__host", region.host), stats);
    label.append(el("span", "region-map__code", region.code), meta);
    label.addEventListener("click", () => select(region));
    group.append(label);
    return { region, label, ping, nearest };
  });

  map.append(world, group);
  return { root: map, glows, markers, labels };
}

/** Show the picker until the player launches a region. */
export function pickRegion(regions: readonly Region[]): Promise<Region> {
  return new Promise((resolve) => {
    const pings = new Map<string, PingState>(regions.map((region) => [region.id, { status: "measuring" }]));
    const guessed = guessRegion(regions);
    // A pick made earlier wins over the nearest region, and so does one made now
    let picked = storedPick(regions);
    let open = true;

    const root = el("div", "region-picker");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Select region");
    const slab = el("section", "region-picker__slab");
    const head = el("div", "region-picker__head");
    const title = el("span", "region-picker__title");
    title.append(el("span", "region-picker__slashes", "//"), " Select region");
    const hint = el("span", "region-picker__hint");
    hint.append("Click a server ", el("span", "region-picker__dot", "·"), " nearest is preselected");
    head.append(title, hint);
    const map = buildMap(regions, (region) => {
      picked = region;
      storePick(region);
      render();
    });
    const body = el("div", "region-picker__body");
    body.append(map.root);
    slab.append(head, body);

    const launch = raiseKey(button("region-picker__launch"), { label: "Launch", variants: ["cta"] });
    const status = el("p", "region-picker__status");
    status.setAttribute("role", "status");
    const foot = el("div", "region-picker__foot");
    foot.append(launch, status);
    root.append(slab, foot);

    const selected = () => picked ?? nearestRegion(regions, pings, guessed);

    function render(): void {
      const chosen = selected();
      const nearest = nearestRegion(regions, pings, guessed);
      map.labels.forEach((entry, index) => {
        const on = entry.region.id === chosen.id;
        entry.label.setAttribute("aria-checked", String(on));
        entry.label.setAttribute(
          "aria-label",
          `${entry.region.name}, ${entry.region.host}, ${pingText(pings.get(entry.region.id))}`,
        );
        entry.label.tabIndex = on ? 0 : -1;
        entry.label.classList.toggle("region-map__label--on", on);
        entry.ping.textContent = pingText(pings.get(entry.region.id));
        entry.nearest.hidden = entry.region.id !== nearest.id;
        map.glows[index].classList.toggle("region-map__glow--on", on);
        map.markers[index].classList.toggle("region-map__pin--on", on);
      });
      setRaisedKeyText(launch, `Launch · ${chosen.code}`);
      status.replaceChildren(
        el("span", "region-picker__status-name", chosen.name),
        " ",
        el("span", "region-picker__status-host", chosen.host),
        " — ready to connect.",
      );
    }

    function finish(region: Region): void {
      if (!open) return;
      open = false;
      window.removeEventListener("keydown", onKey, true);
      root.remove();
      resolve(region);
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(selected());
        return;
      }
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const index = regions.findIndex((region) => region.id === selected().id);
      picked = regions[(index + step + regions.length) % regions.length];
      storePick(picked);
      render();
      map.labels.find((entry) => entry.region.id === picked?.id)?.label.focus();
    }

    launch.addEventListener("click", () => finish(selected()));
    window.addEventListener("keydown", onKey, true);
    document.body.append(root);
    render();
    launch.focus();

    for (const region of regions) {
      background(
        pingLobby(region.lobbyUrl, () => open).then((result) => {
          pings.set(region.id, result);
          if (open) render();
        }),
        "RegionPicker",
      );
    }
  });
}
