/** Terminal match failure stays visible until the player returns to the lobby. */
export function showMatchConnectionFailure(message: string): void {
  if (document.getElementById("match-connection-failure")) return;
  document.exitPointerLock?.();
  const root = document.createElement("div");
  root.id = "match-connection-failure";
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "match-connection-failure-title");
  root.style.cssText =
    "position:fixed;inset:0;z-index:10000;background:#081119f5;color:white;display:grid;place-content:center;gap:1rem;padding:2rem;font-family:system-ui";
  const title = document.createElement("h2");
  title.id = "match-connection-failure-title";
  title.textContent = "Connection lost";
  const text = document.createElement("p");
  text.textContent = message;
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Back to lobby";
  back.addEventListener("click", () => window.location.reload());
  root.append(title, text, back);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      back.focus();
    }
  });
  document.body.append(root);
  back.focus();
}
