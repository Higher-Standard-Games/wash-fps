/**
 * The regions a hosted build can play in, and which one to offer first.
 *
 * The list is washoi.net's `/regions.json`, the one the site's /play page and
 * the native client read, so a new region reaches every client without a
 * release. When it can't be fetched, the copy built in here is used.
 *
 * Only a region's id is ever stored. Its lobby and data addresses always come
 * from the list: every itch.io game shares this build's storage, so a stored
 * address could be one another game wrote.
 */

export interface Region {
  id: string;
  /** Short code set big on the card. */
  code: string;
  name: string;
  host: string;
  /** IANA time zone prefixes that make this the first guess before any ping. */
  timeZones: string[];
  lobbyUrl: string;
  /** The region's data directory, without a trailing "/". */
  dataUrl: string;
}

export const REGIONS_URL = "https://washoi.net/regions.json";

/** The same list as washoi.net's `/regions.json`, for when it can't be fetched. */
export const BUILT_IN_REGIONS: readonly Region[] = [
  {
    id: "eu",
    code: "EU",
    name: "Europe",
    host: "eu.washoi.net",
    timeZones: ["Europe/", "Africa/", "Asia/"],
    lobbyUrl: "wss://eu.washoi.net/lobby",
    dataUrl: "https://eu.washoi.net/data",
  },
  {
    id: "us",
    code: "US",
    name: "North America",
    host: "us.washoi.net",
    timeZones: ["America/", "Pacific/", "US/", "Canada/"],
    lobbyUrl: "wss://us.washoi.net/lobby",
    dataUrl: "https://us.washoi.net/data",
  },
];

/** This machine's lobby and dev server, offered by a staging build (`VITE_LOCAL_REGION`). */
export const LOCAL_REGION: Region = {
  id: "local",
  code: "LOCAL",
  name: "This computer",
  host: "localhost",
  timeZones: [],
  lobbyUrl: "ws://localhost:9000",
  dataUrl: "http://localhost:3000/data",
};

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A published region with the addresses a hosted build may use, or null. */
function readRegion(value: unknown): Region | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const { id, code, name, host, lobbyUrl, dataUrl } = entry;
  if (!text(id) || !text(code) || !text(name) || !text(host)) return null;
  // A region that is not live yet has no addresses; there is nothing to launch
  if (!text(lobbyUrl) || !text(dataUrl)) return null;
  if (!lobbyUrl.startsWith("wss://") || !dataUrl.startsWith("https://")) return null;
  const timeZones = Array.isArray(entry.timeZones) ? entry.timeZones.filter(text) : [];
  return { id, code, name, host, timeZones, lobbyUrl, dataUrl: dataUrl.replace(/\/+$/, "") };
}

/** The live regions in a `/regions.json` document, or null when it isn't one. */
export function parseRegions(json: unknown): Region[] | null {
  if (!json || typeof json !== "object") return null;
  const doc = json as { version?: unknown; regions?: unknown };
  if (doc.version !== 1 || !Array.isArray(doc.regions)) return null;
  const regions = doc.regions.map(readRegion).filter((region): region is Region => region !== null);
  return regions.length ? regions : null;
}

/** The published list, or the built-in one when it can't be fetched in time. */
export async function loadRegions(fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<Region[]> {
  try {
    const response = await fetchImpl(REGIONS_URL, { cache: "no-cache", signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      const regions = parseRegions(await response.json());
      if (regions) return regions;
    }
  } catch {
    // Offline, blocked or slow: the built-in list still plays
  }
  return [...BUILT_IN_REGIONS];
}

/** The region whose time zones match this clock, or the first one. */
export function guessRegion(regions: readonly Region[], timeZone = currentTimeZone()): Region {
  return regions.find((region) => region.timeZones.some((prefix) => timeZone.startsWith(prefix))) ?? regions[0];
}

function currentTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** The player's pick, as washoi.net's /play page stores it. */
const PICK_KEY = "washoi.region";
/** The region this tab launched, so a reload (back from a match) doesn't ask again. */
const TAB_KEY = "washoi.region.tab";

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // The choice just isn't remembered
  }
}

const local = () => localStorage;
const tab = () => sessionStorage;

/** The region last picked, if it is still on the list. */
export function storedPick(regions: readonly Region[]): Region | null {
  const id = read(local, PICK_KEY);
  return regions.find((region) => region.id === id) ?? null;
}

export function storePick(region: Region): void {
  write(local, PICK_KEY, region.id);
}

/** The region this tab already launched, if it is still on the list. */
export function tabRegion(regions: readonly Region[]): Region | null {
  const id = read(tab, TAB_KEY);
  return regions.find((region) => region.id === id) ?? null;
}

export function setTabRegion(region: Region): void {
  write(tab, TAB_KEY, region.id);
}

let active: { region: Region; regions: readonly Region[] } | null = null;

/** The region this hosted build launched, and the list it was picked from. */
export function setActiveRegion(region: Region, regions: readonly Region[]): void {
  active = { region, regions };
}

/**
 * The regions room codes can name: a hosted build's list, or the built-in one
 * (with this machine's) for a build served from a region's own site.
 */
export function knownRegions(): readonly Region[] {
  return active?.regions ?? [...BUILT_IN_REGIONS, LOCAL_REGION];
}

/** The region this client plays in: the one picked, or the one whose lobby the build was made for. */
export function activeRegion(
  lobbyUrl: string = import.meta.env.VITE_LOBBY_URL || LOCAL_REGION.lobbyUrl,
): Region | null {
  return active?.region ?? knownRegions().find((region) => region.lobbyUrl === lobbyUrl) ?? null;
}

/** Forget the active region, for tests. */
export function resetActiveRegionForTests(): void {
  active = null;
}
