import { NetworkGameHost } from "../../../engine/network/client/hosts/NetworkGameHost";
import type { IGameHost } from "../../../engine/network/core/IGameHost";

/**
 * The game host when it talks to a server, for what only a network host has:
 * clock sync, the reliable channel, and prediction's collision world.
 * Null in a local game.
 */
export function networkHostOf(host: IGameHost | null | undefined): NetworkGameHost | null {
  return host instanceof NetworkGameHost ? host : null;
}
