// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isPageDownload } from "../NativeDownloads";

function link(href: string, download?: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  if (download !== undefined) a.download = download;
  return a;
}

describe("isPageDownload", () => {
  it("takes files the page made, not links", () => {
    expect(isPageDownload(link("blob:https://eu.washoi.net/1234", "key.txt"))).toBe(true);
    expect(isPageDownload(link("data:text/plain,hi", "a.txt"))).toBe(true);
    expect(isPageDownload(link("blob:https://eu.washoi.net/1234"))).toBe(false);
    expect(isPageDownload(link("https://eu.washoi.net/data/demos/a.shagdemo", "a.shagdemo"))).toBe(false);
  });
});
