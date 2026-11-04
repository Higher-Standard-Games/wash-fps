import { MapLoader } from "../../../../../engine/loader/map/MapLoader";
import { mapTitle } from "../../../../../engine/ui/MapTitles";
import { MatchStateManager } from "../../MatchStateManager";
import { SettingsRailOverlay } from "./SettingsRailOverlay";

/**
 * FPSSettingsOverlay - the settings screen over a match, laid out as the lobby
 * lays it out: the page keys on the match menu's gold rail, the page on the
 * stage beside it. Back returns to the match menu. The kicker names the match
 * from the map loaded and the match state.
 */
export class FPSSettingsOverlay extends SettingsRailOverlay {
  public override open(): void {
    const map = MapLoader.getInstance().getCurrentMap();
    const where = map ? (mapTitle(map) ?? map) : "";
    this.openWith([MatchStateManager.getInstance().gametypeName, where].filter(Boolean).join(" · "));
  }
}
