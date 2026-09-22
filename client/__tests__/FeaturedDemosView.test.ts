// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobbyClient } from "../../../../lobby/LobbyClient";
import { LobbyPanel } from "../LobbyPanel";
import { bindFeaturedDemos } from "../NewUiApi";

afterEach(() => bindFeaturedDemos({ connected: false } as LobbyClient, false));

describe("featured demo presentation", () => {
  it("shows server picks as safe text and an honest selection rule", () => {
    const host = document.createElement("section");
    const client = { connected: true } as LobbyClient;
    bindFeaturedDemos(client, true);
    const panel = Object.create(LobbyPanel.prototype) as {
      featuredHostEl: HTMLElement;
      lobbyClient: LobbyClient;
      featuredRequested: boolean;
      featuredLoading: boolean;
      featuredError: string | null;
      featuredSelected: number;
      featuredEntries: unknown[];
      buildDemoCard: () => HTMLElement;
      renderFeaturedDemos: () => void;
    };
    Object.assign(panel, {
      featuredHostEl: host,
      lobbyClient: client,
      featuredRequested: true,
      featuredLoading: false,
      featuredError: null,
      featuredSelected: 0,
      featuredEntries: [
        {
          demo: {
            filename: "real.shagdemo",
            map: "wdm2",
            mapDisplayName: "Proving Grounds",
            players: ["One", "<img src=x onerror=alert(1)>"],
          },
          rank: 1,
          reason: "Recent multiplayer recording",
        },
      ],
      buildDemoCard: () => document.createElement("article"),
    });
    panel.renderFeaturedDemos();
    expect(host.textContent).toContain("Recent multiplayer recordings · last 7 days");
    expect(host.textContent).toContain("Proving Grounds");
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(1);
    (panel.featuredEntries[0] as { reason: string }).reason = "Features a 30-day top 10 player";
    panel.renderFeaturedDemos();
    expect(host.textContent).toContain("30-day top 10 players · recordings from last 7 days");
  });

  it("requests the verified Yours scope from the lobby instead of filtering names", () => {
    const requestDemoList = vi.fn();
    const panel = Object.create(LobbyPanel.prototype) as {
      lobbyClient: LobbyClient;
      demosArchive: unknown[];
      demosMode: string;
      demosMap: string;
      demosSearch: string;
      demosPage: number;
      demosRequested: boolean;
      demosScope: string;
      demoOwnershipSupported: boolean;
      featuredEntries: unknown[];
      featuredRequested: boolean;
      featuredLoading: boolean;
      featuredError: string | null;
      buildDemosTab: () => HTMLElement;
    };
    Object.assign(panel, {
      lobbyClient: { connected: true, requestDemoList } as unknown as LobbyClient,
      demosArchive: [],
      demosMode: "all",
      demosMap: "all",
      demosSearch: "",
      demosPage: 0,
      demosRequested: false,
      demosScope: "latest",
      demoOwnershipSupported: true,
      featuredEntries: [],
      featuredRequested: false,
      featuredLoading: false,
      featuredError: null,
    });
    const page = panel.buildDemosTab();
    const keys = [...page.querySelectorAll<HTMLButtonElement>(".lobby__demo-scopes button")];
    expect(keys.map((key) => key.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Latest"), expect.stringContaining("Yours")]),
    );
    keys.find((key) => key.textContent?.includes("Yours"))?.click();
    expect(requestDemoList).toHaveBeenCalledWith(64, "yours");
    expect(panel.demosScope).toBe("yours");
  });
});
