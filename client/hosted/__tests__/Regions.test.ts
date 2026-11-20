// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nearestRegion } from "../RegionPicker";
import {
  BUILT_IN_REGIONS,
  guessRegion,
  loadRegions,
  parseRegions,
  REGIONS_URL,
  setTabRegion,
  storedPick,
  storePick,
  tabRegion,
} from "../Regions";

const published = {
  version: 1,
  regions: [
    {
      id: "eu",
      code: "EU",
      name: "Europe",
      host: "eu.washoi.net",
      pin: { lon: 10, lat: 50 },
      timeZones: ["Europe/"],
      playUrl: "https://eu.washoi.net/",
      lobbyUrl: "wss://eu.washoi.net/lobby",
      dataUrl: "https://eu.washoi.net/data/",
    },
    {
      id: "asia",
      code: "AS",
      name: "Asia",
      host: "asia.washoi.net",
      timeZones: ["Asia/"],
      playUrl: null,
      lobbyUrl: null,
      dataUrl: null,
    },
    {
      id: "plain",
      code: "PL",
      name: "Plain",
      host: "plain.example",
      lobbyUrl: "ws://plain.example/lobby",
      dataUrl: "http://plain.example/data",
    },
  ],
};

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("region list", () => {
  it("keeps live regions with secure addresses, without a trailing slash on the data URL", () => {
    const regions = parseRegions(published);
    expect(regions?.map((region) => region.id)).toEqual(["eu"]);
    expect(regions?.[0].dataUrl).toBe("https://eu.washoi.net/data");
  });

  it("refuses a document of another version or with no live region", () => {
    expect(parseRegions({ ...published, version: 2 })).toBeNull();
    expect(parseRegions({ version: 1, regions: [published.regions[1]] })).toBeNull();
    expect(parseRegions("nope")).toBeNull();
  });

  it("uses the built-in list when the published one can't be read", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await loadRegions(failing as unknown as typeof fetch)).toEqual(BUILT_IN_REGIONS);
    expect(failing).toHaveBeenCalledWith(REGIONS_URL, expect.objectContaining({ cache: "no-cache" }));
    const answering = vi.fn(async () => new Response(JSON.stringify(published)));
    expect((await loadRegions(answering as unknown as typeof fetch)).map((region) => region.id)).toEqual(["eu"]);
  });

  it("guesses from the clock's time zone, else the first region", () => {
    expect(guessRegion(BUILT_IN_REGIONS, "America/Chicago").id).toBe("us");
    expect(guessRegion(BUILT_IN_REGIONS, "Europe/Helsinki").id).toBe("eu");
    expect(guessRegion(BUILT_IN_REGIONS, "Etc/UTC").id).toBe("eu");
  });

  it("stores only ids, and ignores a stored id that is not on the list", () => {
    storePick(BUILT_IN_REGIONS[1]);
    expect(localStorage.getItem("washoi.region")).toBe("us");
    expect(storedPick(BUILT_IN_REGIONS)?.id).toBe("us");
    localStorage.setItem("washoi.region", "wss://evil.example/lobby");
    expect(storedPick(BUILT_IN_REGIONS)).toBeNull();
    setTabRegion(BUILT_IN_REGIONS[0]);
    expect(tabRegion(BUILT_IN_REGIONS)?.id).toBe("eu");
    expect(tabRegion([BUILT_IN_REGIONS[1]])).toBeNull();
  });

  it("marks the fastest region that answered, else the guess", () => {
    const [eu, us] = BUILT_IN_REGIONS;
    expect(nearestRegion(BUILT_IN_REGIONS, new Map(), us).id).toBe("us");
    const pings = new Map([
      ["eu", { status: "ok" as const, ms: 90 }],
      ["us", { status: "ok" as const, ms: 40 }],
    ]);
    expect(nearestRegion(BUILT_IN_REGIONS, pings, eu).id).toBe("us");
    expect(nearestRegion(BUILT_IN_REGIONS, new Map([["us", { status: "unreachable" as const }]]), eu).id).toBe("eu");
  });
});
