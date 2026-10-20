/**
 * MarkdownLite — the bit of Markdown our own documents use (CREDITS.md),
 * turned into DOM nodes for an in-game dialog.
 *
 * - `#`–`######` headings, paragraphs, `-`/`*`/`1.` lists, nested one level by
 *   indenting two or more spaces, and `---` rules.
 * - Inline `**bold**`, `*italic*` / `_italic_`, `` `code` ``, `[text](url)`.
 * - Links open in a new tab and only for http(s) and mailto; anything else is plain text.
 * - HTML comments are skipped and other HTML is shown as text: nodes are built
 *   with textContent, never innerHTML, so the file cannot inject markup.
 */

export interface MarkdownOptions {
  /** Added to each heading level: 1 makes `#` an h2. Levels stop at h6. */
  headingOffset?: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

export function renderMarkdown(source: string, options: MarkdownOptions = {}): DocumentFragment {
  const offset = options.headingOffset ?? 0;
  const out = document.createDocumentFragment();
  const lines = source
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n");
  let paragraph: string[] = [];
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let item: ListItem | null = null;
  let subList: HTMLUListElement | HTMLOListElement | null = null;
  let subItem: ListItem | null = null;

  const flushSub = () => {
    writeItem(subItem);
    subItem = null;
    subList = null;
  };
  const flushItem = () => {
    flushSub();
    writeItem(item);
    item = null;
  };
  const flush = () => {
    if (paragraph.length) {
      const p = document.createElement("p");
      p.append(inline(paragraph.join(" ")));
      out.append(p);
      paragraph = [];
    }
    flushItem();
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1].length + offset);
      const node = document.createElement(`h${level}` as "h1");
      node.append(inline(heading[2]));
      out.append(node);
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.append(document.createElement("hr"));
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      const text = (bullet ?? numbered)![1];
      const parent: ListItem | null = item;
      if (parent && raw.length - raw.trimStart().length >= 2) {
        // An indented item nests under the item above it.
        if (subList && subList.tagName.toLowerCase() !== tag) flushSub();
        writeItem(subItem);
        writeItem(parent);
        if (!subList) {
          subList = document.createElement(tag);
          parent.node.append(subList);
        }
        subItem = { node: document.createElement("li"), text: [text] };
        subList.append(subItem.node);
        continue;
      }
      if (paragraph.length || (list && list.tagName.toLowerCase() !== tag)) flush();
      flushItem();
      if (!list) {
        list = document.createElement(tag);
        out.append(list);
      }
      item = { node: document.createElement("li"), text: [text] };
      list.append(item.node);
      continue;
    }
    // A wrapped line continues the list item or paragraph it follows.
    const open: ListItem | null = subItem ?? item;
    if (open) open.text.push(line);
    else paragraph.push(line);
  }
  flush();
  return out;
}

interface ListItem {
  node: HTMLLIElement;
  /** Lines not yet written into `node`; emptied once written. */
  text: string[];
}

function writeItem(item: ListItem | null): void {
  if (!item?.text.length) return;
  item.node.append(inline(item.text.join(" ")));
  item.text = [];
}

/** Inline marks, links and code in one line of text. */
export function inline(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let rest = text;
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|\b_(.+?)_\b/;
  while (rest) {
    const match = pattern.exec(rest);
    if (!match) {
      out.append(rest);
      break;
    }
    if (match.index > 0) out.append(rest.slice(0, match.index));
    const [whole, code, label, href, strong, strong2, em, em2] = match;
    if (code !== undefined) {
      const node = document.createElement("code");
      node.textContent = code;
      out.append(node);
    } else if (label !== undefined) {
      out.append(link(label, href));
    } else if (strong !== undefined || strong2 !== undefined) {
      const node = document.createElement("strong");
      node.append(inline(strong ?? strong2));
      out.append(node);
    } else {
      const node = document.createElement("em");
      node.append(inline(em ?? em2));
      out.append(node);
    }
    rest = rest.slice(match.index + whole.length);
  }
  return out;
}

function link(label: string, href: string): Node {
  if (!/^(https?:|mailto:)/i.test(href)) return inline(label);
  const node = document.createElement("a");
  node.href = href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  node.append(inline(label));
  return node;
}
