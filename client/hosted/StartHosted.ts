/**
 * Start-up for a hosted build, before anything loads: pick the region, then
 * point the lobby and every `/data/` path at it.
 *
 * The page reloads after each match (ReturnToLobby), so the region this tab
 * launched is used again without asking.
 */

import { installHostedPublicUrls } from "../../../../engine/core/PublicUrls";
import { keepPlayerKeyInMemory } from "../../../../lobby/AccountSession";
import { setFpsLobbyUrl } from "../FpsLobbyService";
import { pickRegion } from "./RegionPicker";
import { LOCAL_REGION, loadRegions, type Region, setTabRegion, tabRegion } from "./Regions";

export interface HostedStart {
  region: Region;
  /** True when the player clicked Launch now, which also counts as the start-up screen's click. */
  launched: boolean;
}

export async function startHostedBuild(): Promise<HostedStart> {
  const listed = await loadRegions();
  const regions = import.meta.env.VITE_LOCAL_REGION === "1" ? [...listed, LOCAL_REGION] : listed;
  const again = tabRegion(regions);
  const region = again ?? (await pickRegion(regions));
  setTabRegion(region);
  installHostedPublicUrls({ dataBase: region.dataUrl, buildBase: import.meta.env.BASE_URL });
  setFpsLobbyUrl(region.lobbyUrl);
  keepPlayerKeyInMemory();
  return { region, launched: again === null };
}
