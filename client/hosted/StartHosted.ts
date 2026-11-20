/**
 * Start-up for a hosted build, before anything loads: pick the region, then
 * point the lobby and every `/data/` path at it.
 *
 * The page reloads after each match (ReturnToLobby), so the region this tab
 * launched is used again without asking.
 */

import { installHostedPublicUrls } from "../../../../engine/core/PublicUrls";
import { setUpHostedLogin } from "../../../../lobby/AccountSession";
import { setFpsLobbyUrl } from "../FpsLobbyService";
import { HOSTED_ON } from "./HostedBuild";
import { installHostedLinks } from "./HostedLinks";
import { pickRegion } from "./RegionPicker";
import { LOCAL_REGION, loadRegions, type Region, setActiveRegion, setTabRegion, tabRegion } from "./Regions";

export interface HostedStart {
  region: Region;
  /** True when the player clicked Launch now, which also counts as the start-up screen's click. */
  launched: boolean;
}

export async function startHostedBuild(): Promise<HostedStart> {
  const listed = await loadRegions();
  // A staging build offers this machine's lobby only when it is served from
  // this machine: browsers keep a page on itch.io from reaching localhost
  const local = import.meta.env.VITE_LOCAL_REGION === "1" && ["localhost", "127.0.0.1"].includes(location.hostname);
  const regions = local ? [...listed, LOCAL_REGION] : listed;
  const again = tabRegion(regions);
  const region = again ?? (await pickRegion(regions));
  setTabRegion(region);
  setActiveRegion(region, regions);
  installHostedPublicUrls({ dataBase: region.dataUrl, buildBase: import.meta.env.BASE_URL });
  setFpsLobbyUrl(region.lobbyUrl);
  setUpHostedLogin(HOSTED_ON ?? "itch", region.id);
  installHostedLinks();
  return { region, launched: again === null };
}
