/**
 * The game's logo at the head of a gold rail: the lobby's, the match menu's
 * and the in-game settings'. The logo is media and may not be installed, so the
 * name set in type stands in until it loads, and for good if it never does.
 */
export function buildRailBrand(className: string): HTMLElement {
  const brand = document.createElement("div");
  brand.className = className;
  const logo = document.createElement("img");
  logo.src = "/data/washoi.png";
  logo.alt = "Washiki Washoi";
  const fallback = document.createElement("span");
  fallback.textContent = "WASHIKI WASHOI";
  logo.hidden = true;
  logo.addEventListener("load", () => {
    logo.hidden = false;
    fallback.hidden = true;
  });
  logo.addEventListener("error", () => {
    logo.hidden = true;
    fallback.hidden = false;
  });
  brand.append(logo, fallback);
  return brand;
}
