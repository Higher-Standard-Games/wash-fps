// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputSystem } from "../../../../engine/input/InputSystem";
import { CreditsDialog } from "../credits/CreditsDialog";
import { renderMarkdown } from "../credits/MarkdownLite";

function html(source: string, headingOffset = 0): string {
  const host = document.createElement("div");
  host.append(renderMarkdown(source, { headingOffset }));
  return host.innerHTML;
}

describe("MarkdownLite", () => {
  it("renders headings, paragraphs, lists and rules", () => {
    expect(html("# Title\n\nOne line\nwrapped.\n\n- a\n- b\n  continued\n\n1. first\n\n---")).toBe(
      "<h1>Title</h1><p>One line wrapped.</p><ul><li>a</li><li>b continued</li></ul><ol><li>first</li></ol><hr>",
    );
  });

  it("nests indented items one level under the item above", () => {
    expect(html("- Playtesters:\n  - one\n  - two\n    wrapped\n- Next")).toBe(
      "<ul><li>Playtesters:<ul><li>one</li><li>two wrapped</li></ul></li><li>Next</li></ul>",
    );
  });

  it("shifts heading levels", () => {
    expect(html("# A\n## B\n###### C", 1)).toBe("<h2>A</h2><h3>B</h3><h6>C</h6>");
  });

  it("renders inline marks and links", () => {
    expect(html("**bold** *it* _also_ `x*y` [site](https://example.com)")).toBe(
      '<p><strong>bold</strong> <em>it</em> <em>also</em> <code>x*y</code> <a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a></p>',
    );
  });

  it("keeps underscores inside words", () => {
    expect(html("snake_case_name")).toBe("<p>snake_case_name</p>");
  });

  it("skips comments and shows other HTML as text", () => {
    expect(html("<!-- note\nmore -->\nhi <b>there</b> <img src=x onerror=alert(1)>")).toBe(
      "<p>hi &lt;b&gt;there&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt;</p>",
    );
  });

  it("only links http(s) and mailto", () => {
    expect(html("[bad](javascript:alert) [mail](mailto:a@b.c)")).toBe(
      '<p>bad <a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">mail</a></p>',
    );
  });
});

describe("CreditsDialog", () => {
  let background: HTMLElement;
  let dialog: CreditsDialog | null;
  const onClose = vi.fn();

  beforeEach(() => {
    document.body.replaceChildren();
    background = document.createElement("div");
    document.body.append(background);
    onClose.mockReset();
    dialog = null;
  });
  afterEach(() => dialog?.destroy());

  it("shows CREDITS.md below its own header, without the file's title", () => {
    dialog = new CreditsDialog({ background, onClose });
    const body = document.querySelector(".lobby-credits__body")!;
    expect(document.querySelector("#lobby-credits-title")?.textContent).toBe("Credits & copyrights");
    expect(body.querySelector("h1")).toBeNull();
    expect([...body.querySelectorAll("h2")].map((h) => h.textContent)).toContain("Built with");
    expect(body.textContent).not.toContain("shown in game");
    expect(background.inert).toBe(true);
  });

  it("closes on Escape and the Close button, and gives the page back", () => {
    dialog = new CreditsDialog({ background, onClose }, "# Credits\n\nHello");
    expect(InputSystem.getInstance().getActiveContext()).toBe("fps_credits");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    (document.querySelector(".lobby-credits__close") as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(2);
    dialog.destroy();
    expect(document.querySelector(".lobby-credits")).toBeNull();
    expect(background.inert).toBeFalsy();
    expect(InputSystem.getInstance().getActiveContext()).not.toBe("fps_credits");
  });
});
