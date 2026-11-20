/**
 * Links in a hosted build: the game runs in a frame on its host's page, so a
 * link that opened in place would replace the game. Links to other sites
 * open in a new tab instead.
 */

import { isExternal } from "../native/LinkPolicy";

export function installHostedLinks(doc: Document = document): void {
  doc.addEventListener(
    "click",
    (event) => {
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.hasAttribute("download") || link.target === "_blank") return;
      if (!isExternal(link.href, doc.location.origin)) return;
      event.preventDefault();
      doc.defaultView?.open(link.href, "_blank", "noopener");
    },
    true,
  );
}
