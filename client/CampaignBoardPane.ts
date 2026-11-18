/**
 * The campaign's boards on the Leaderboard page: the top scorers over the whole
 * campaign, the first to finish it, and each operation's top fraggers and first
 * clear. Every number is the lobby's; names are the accounts' names now.
 */

import { UIStyles } from "../../../engine/ui/UIStyles";
import { currentIdentity } from "../../../lobby/AccountSession";
import type { CampaignBoardRow } from "../../../lobby/types";
import { campaignStory } from "./campaign/CampaignStory";
import type { CampaignBoard } from "./NewUiApi";
import leaderboardCss from "./styles/Leaderboard.css?raw";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A date as a day: "14 Nov 2026". */
function day(at: number | undefined): string {
  if (at === undefined) return "";
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Each operation's card shows this many of its top fraggers. */
const OPERATION_ROWS = 3;

export type CampaignBoardState =
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | { state: "ready"; board: CampaignBoard };

export class CampaignBoardPane {
  readonly root = el("section", "lb-pane lb-camp");

  constructor() {
    // The boards are the leaderboard's rows and panels, wherever they are shown
    UIStyles.injectCSS("lobby-leaderboard", leaderboardCss);
  }

  render(loaded: CampaignBoardState): void {
    if (loaded.state !== "ready") {
      this.root.replaceChildren(
        el("p", "lb-status", loaded.state === "loading" ? "Reading the campaign boards…" : loaded.reason),
      );
      return;
    }
    const { board } = loaded;
    if (board.scorers.length === 0) {
      this.root.replaceChildren(el("p", "lb-status", "No one has cleared an operation yet."));
      return;
    }
    const lists = el("div", "lb-camp__lists");
    lists.append(
      this.list(
        "Top scorers",
        board.scorers,
        (row) => [`${row.frags ?? 0}`, `${row.cleared ?? 0} / ${board.missionCount}`],
        ["Frags", "Cleared"],
      ),
      this.list(
        "First to finish",
        board.finishers,
        (row) => [day(row.at)],
        ["Finished"],
        "Nobody has finished it yet.",
      ),
    );
    const operations = el("div", "lb-camp__ops");
    for (const mission of board.missions) operations.append(this.operation(mission));
    this.root.replaceChildren(lists, operations);
  }

  private list(
    title: string,
    rows: readonly CampaignBoardRow[],
    values: (row: CampaignBoardRow) => string[],
    columns: string[],
    empty = "",
  ): HTMLElement {
    const section = el("section", "lb-board lb-camp__board");
    section.setAttribute("aria-label", title);
    const head = el("div", "lb-camp__head");
    head.append(el("h2", "lb-camp__title", title));
    const table = el("div", "lb-rows");
    const header = el("div", `lb-row lb-row--head lb-row--camp lb-row--camp-${columns.length}`);
    header.setAttribute("aria-hidden", "true");
    header.append(el("span", "", "Rank"), el("span", "", "Player"), ...columns.map((c) => el("span", "lb-num", c)));
    table.append(header);
    if (rows.length === 0) table.append(el("p", "lb-camp__empty", empty));
    for (const row of rows) table.append(this.row(row, values(row), columns.length));
    section.append(head, table);
    return section;
  }

  private row(entry: CampaignBoardRow, values: string[], columns: number): HTMLElement {
    const isYou = entry.playerId === currentIdentity()?.id;
    const row = el(
      "div",
      `lb-row lb-row--camp lb-row--camp-${columns}${entry.rank <= 3 ? ` lb-row--${entry.rank}` : ""}${isYou ? " is-you" : ""}`,
    );
    const who = el("span", "lb-row__who");
    who.append(el("span", "lb-row__name", entry.name));
    if (isYou) who.append(el("span", "lb-row__you", "You"));
    row.append(
      el("span", "lb-row__rank", `#${entry.rank}`),
      who,
      ...values.map((value, index) => el("span", index === 0 ? "lb-num is-key" : "lb-num", value)),
    );
    return row;
  }

  /** One operation: its name on the campaign's plate, its top fraggers, and who cleared it first. */
  private operation(mission: CampaignBoard["missions"][number]): HTMLElement {
    const card = el("article", "lb-camp__op");
    const title = campaignStory(mission.id)?.title ?? mission.id;
    card.setAttribute("aria-label", title);
    card.append(el("h3", "lb-camp__op-title campaign-plate campaign-plate--dark", title));
    if (mission.scorers.length === 0) {
      card.append(el("p", "lb-camp__empty", "Not cleared yet"));
      return card;
    }
    const top = el("ol", "lb-camp__op-top");
    for (const row of mission.scorers.slice(0, OPERATION_ROWS)) {
      const item = el("li", row.playerId === currentIdentity()?.id ? "is-you" : "");
      item.append(el("span", "lb-camp__op-name", row.name), el("strong", "", `${row.frags ?? 0}`));
      top.append(item);
    }
    const first = mission.firstClears[0];
    card.append(top);
    if (first) {
      const line = el("p", "lb-camp__op-first");
      line.append("★ ", el("span", "lb-camp__op-name", first.name), ` · ${day(first.at)}`);
      line.title = "Cleared it first";
      card.append(line);
    }
    return card;
  }
}
