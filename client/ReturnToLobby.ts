import { HOSTED_ON } from "./hosted/HostedBuild";

/**
 * The completed-match action opens Play without rejoining the old room. On
 * our own site that is the site's root; a hosted build reloads its own page,
 * which is all it has.
 */
export function returnToLobby(
  navigate: (url: string) => void = (url) => {
    window.location.href = url;
  },
  hosted: boolean = HOSTED_ON !== null,
): void {
  try {
    sessionStorage.removeItem("shag.return_lobby");
  } catch {
    // Navigation does not depend on access to optional return metadata.
  }
  navigate(hosted ? window.location.href : new URL(window.location.origin).href);
}
