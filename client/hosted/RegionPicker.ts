/**
 * The region picker a hosted build shows before anything else, as washoi.net's
 * /play page and the native client do: one card per region with its ping, the
 * nearest one marked, and a Launch key.
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
import "./RegionPicker.css";

type PingState = PingResult | { status: "measuring" };

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
    root.setAttribute("aria-labelledby", "region-picker-title");
    const card = el("section", "region-picker__card");
    const title = el("h1", "region-picker__title", "Choose a region");
    title.id = "region-picker-title";
    const list = el("div", "region-picker__regions");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-labelledby", title.id);
    const launch = raiseKey(button("region-picker__launch"), { label: "Launch", variants: ["cta"] });

    const cards = regions.map((region) => {
      const option = button("region-picker__region");
      option.setAttribute("role", "radio");
      option.dataset.region = region.id;
      const ping = el("span", "region-picker__ping");
      const nearest = el("span", "region-picker__nearest", "Nearest");
      option.append(
        el("span", "region-picker__code", region.code),
        el("span", "region-picker__name", region.name),
        el("span", "region-picker__host", region.host),
        ping,
        nearest,
      );
      option.addEventListener("click", () => {
        picked = region;
        storePick(region);
        render();
      });
      option.addEventListener("dblclick", () => finish(region));
      return { region, option, ping, nearest };
    });

    const selected = () => picked ?? nearestRegion(regions, pings, guessed);

    function render(): void {
      const chosen = selected();
      const nearest = nearestRegion(regions, pings, guessed);
      for (const entry of cards) {
        const on = entry.region.id === chosen.id;
        entry.option.setAttribute("aria-checked", String(on));
        entry.option.tabIndex = on ? 0 : -1;
        entry.option.classList.toggle("region-picker__region--on", on);
        entry.ping.textContent = pingText(pings.get(entry.region.id));
        entry.nearest.hidden = entry.region.id !== nearest.id;
      }
      setRaisedKeyText(launch, `Launch · ${chosen.code}`);
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
      cards.find((entry) => entry.region.id === picked?.id)?.option.focus();
    }

    launch.addEventListener("click", () => finish(selected()));
    window.addEventListener("keydown", onKey, true);
    list.append(...cards.map((entry) => entry.option));
    card.append(title, list, launch);
    root.append(card);
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
