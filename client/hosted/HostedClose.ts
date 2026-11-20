/**
 * The close plate a hosted build's lobby shows in its top-left corner, where
 * the demo player has its ✕. itch.io's "launch in fullscreen" fills the window
 * with the game and offers no way out of its own; its page's Back does it, so
 * the plate goes back one step. The game keeps running in its box on the page.
 *
 * Only in a frame: a hosted build opened on its own has no page to go back to.
 */

import { HOSTED_ON } from "./HostedBuild";
import "./HostedClose.css";

export function hostedClosePlate(win: Window = window): HTMLButtonElement | null {
  if (HOSTED_ON === null || win.top === win) return null;
  const plate = win.document.createElement("button");
  plate.type = "button";
  plate.className = "hosted-close";
  plate.textContent = "✕";
  plate.title = "Close the game";
  plate.setAttribute("aria-label", "Close the game");
  plate.addEventListener("click", () => win.history.back());
  return plate;
}
