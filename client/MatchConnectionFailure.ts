import { leavePlay } from "../../../engine/input/PlayCapture";
import { UIStyles } from "../../../engine/ui/UIStyles";
import washikiTheme from "./hud/styles/WashikiTheme.css?raw";
import failureCSS from "./styles/MatchConnectionFailure.css?raw";

/**
 * Terminal match failure stays visible until the player returns to the lobby.
 * `onBack` replaces the reload, for a page that is already the lobby (the
 * native client's, after its match failed).
 */
export function showMatchConnectionFailure(message: string, onBack?: () => void): void {
  if (document.getElementById("match-connection-failure")) return;
  leavePlay();
  // The match can fail before the HUD has brought in the game's fonts
  UIStyles.injectCSS("washiki-theme", washikiTheme);
  UIStyles.injectCSS("match-connection-failure", failureCSS);
  const root = document.createElement("div");
  root.id = "match-connection-failure";
  root.className = "match-failure";
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "match-connection-failure-title");
  root.setAttribute("aria-describedby", "match-connection-failure-message");
  const card = document.createElement("div");
  card.className = "match-failure__card";
  const eyebrow = document.createElement("div");
  eyebrow.className = "match-failure__eyebrow";
  eyebrow.textContent = "Match";
  const title = document.createElement("h2");
  title.id = "match-connection-failure-title";
  title.className = "match-failure__title";
  title.textContent = "Connection lost";
  const text = document.createElement("p");
  text.id = "match-connection-failure-message";
  text.className = "match-failure__message";
  text.textContent = message;
  const back = document.createElement("button");
  back.type = "button";
  back.className = "match-failure__back";
  back.textContent = "Back to lobby";
  back.addEventListener("click", () => {
    if (!onBack) {
      window.location.reload();
      return;
    }
    root.remove();
    onBack();
  });
  card.append(eyebrow, title, text, back);
  root.append(card);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      back.focus();
    }
  });
  document.body.append(root);
  back.focus();
}
