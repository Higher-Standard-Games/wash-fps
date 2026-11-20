import { createRaisedKey } from "../../../engine/ui/components/RaisedKey";
import { inThisRegion, type RoomRef } from "./LobbyCode";

/** The small key a chat message gets when it names a room. */
export function roomJoinKey(room: RoomRef, join: () => void): HTMLButtonElement {
  const label = inThisRegion(room) ? "Join" : `Join · ${room.region?.code}`;
  const key = createRaisedKey({ label, variants: ["sm", "cream", "inline"] });
  key.classList.add("lobby-chat__join");
  key.setAttribute("aria-label", `Join room ${room.lobbyId}${inThisRegion(room) ? "" : ` in ${room.region?.name}`}`);
  key.addEventListener("click", join);
  return key;
}
