/** Return metadata is optional: blocked storage must still let a player leave. */
export function returnToLobby(
  navigate: (url: string) => void = (url) => {
    window.location.href = url;
  },
  reload: () => void = () => window.location.reload(),
): void {
  let returnUrl: URL | null = null;
  try {
    const room = sessionStorage.getItem("shag.return_lobby");
    if (room) {
      returnUrl = new URL(window.location.origin);
      returnUrl.searchParams.set("lobby", room);
      const invite = sessionStorage.getItem(`shag.private_invite.${room}`);
      if (invite) returnUrl.searchParams.set("invite", invite);
    }
  } catch {
    // A reload remains usable even if either metadata read throws.
    returnUrl = null;
  }
  if (returnUrl) navigate(returnUrl.href);
  else reload();
}
