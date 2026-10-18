/** The completed-match action opens Play without rejoining the old room. */
export function returnToLobby(
  navigate: (url: string) => void = (url) => {
    window.location.href = url;
  },
): void {
  try {
    sessionStorage.removeItem("shag.return_lobby");
  } catch {
    // Navigation does not depend on access to optional return metadata.
  }
  navigate(new URL(window.location.origin).href);
}
