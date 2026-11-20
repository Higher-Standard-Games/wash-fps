import { HOSTED_ON } from "./hosted/HostedBuild";

/**
 * The completed-match action opens Play without rejoining the old room. On
 * our own site that is the site's root; a hosted build reloads its own page,
 * which is all it has. It replaces its history entry: the frame shares the
 * host page's history, where Back should leave the full-window game.
 */
export function returnToLobby(navigate?: (url: string) => void, hosted: boolean = HOSTED_ON !== null): void {
  const go =
    navigate ??
    ((url: string) => {
      if (hosted) window.location.replace(url);
      else window.location.href = url;
    });
  try {
    sessionStorage.removeItem("shag.return_lobby");
  } catch {
    // Navigation does not depend on access to optional return metadata.
  }
  go(hosted ? window.location.href : new URL(window.location.origin).href);
}
