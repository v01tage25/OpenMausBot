// The board's decisions, without a DOM.
//
// These tests exist because the same handful of judgements come up in three
// places — the filter, the columns, and the buttons — and the expensive
// failures are the ones where they disagree: a card filed under a team while
// its badge says another, a drop that writes an order landing the card where
// nobody aimed it, or a Run button that is live on a card that cannot run.
import { describe, expect, it } from "vitest";

import {
  WORK_COLUMNS,
  cardSection,
  cardStatusLabel,
  columnsOf,
  dropPatch,
  elapsedLabel,
  filterByTeam,
  orderBetween,
  runAvailability,
  statusTone,
  stopAvailability,
  teamOptions,
  type BoardCard,
} from "./task-board";

let seq = 0;

/** A card, with only the fields a test cares about spelled out. */
const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: `c${++seq}`,
  title: "A job",
  status: "todo",
  order: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

/** A card owned by a bot filed under `section`. */
const owned = (section: string, over: Partial<BoardCard> = {}): BoardCard =>
  card({
    ownerBotId: "bot-1",
    agent: { id: "bot-1", name: "Worker", section },
    ...over,
  });

describe("cardSection", () => {
  it("files a card under its owner's team", () => {
    expect(cardSection(owned("Alpha"))).toBe("Alpha");
  });

  it("puts a card with no owner in the unsectioned team", () => {
    // Not in EVERY team: a card that appears in two teams at once is the one
    // thing the switcher must never do.
    expect(cardSection(card())).toBe("");
  });

  it("treats a hidden owner's card as unsectioned, exactly as the server does", () => {
    // The badge and the filter read the same answer, so a hidden owner's card
    // cannot claim a team it is no longer shown in.
    const hidden = card({
      ownerBotId: "bot-1",
      agent: { id: "bot-1", name: "Ghost", section: "Alpha", hidden: true },
    });
    expect(cardSection(hidden)).toBe("");
  });

  it("ignores surrounding whitespace so a padded section is not its own team", () => {
    expect(cardSection(owned("  Alpha  "))).toBe("Alpha");
  });
});

describe("filterByTeam", () => {
  const alpha = owned("Alpha", { title: "alpha work" });
  const beta = owned("Beta", { title: "beta work" });
  const loose = card({ title: "loose work" });

  it("shows only the named team's cards", () => {
    expect(filterByTeam([alpha, beta, loose], "Alpha")).toEqual([alpha]);
  });

  it("shows the unsectioned cards for the empty team, which is a real selection", () => {
    // "" is not "no filter" — it is the team a bot lands in when nobody filed
    // it, and it must be reachable.
    expect(filterByTeam([alpha, beta, loose], "")).toEqual([loose]);
  });

  it("shows everything when no team is selected", () => {
    expect(filterByTeam([alpha, beta, loose], null)).toHaveLength(3);
  });
});

describe("columnsOf", () => {
  it("has a column for every status, in board order", () => {
    const columns = columnsOf([]);
    expect(Object.keys(columns)).toEqual([...WORK_COLUMNS]);
    expect(WORK_COLUMNS[0]).toBe("backlog");
  });

  it("orders a column by the order a drop writes, not by when the card was made", () => {
    const second = card({ order: 2, createdAt: 500 });
    const first = card({ order: 1, createdAt: 9_000 });
    expect(columnsOf([second, first]).todo.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it("keeps a card whose status this client does not know rather than dropping it", () => {
    const stranger = card({ status: "shipping" as BoardCard["status"] });
    // Losing work off the board because a newer server used a status this
    // build has never heard of would be far worse than showing it misplaced.
    expect(columnsOf([stranger]).backlog.map((c) => c.id)).toEqual([stranger.id]);
  });
});

describe("orderBetween", () => {
  it("places a card below the one it follows", () => {
    expect(orderBetween(undefined, card({ order: 5 }))).toBe(4);
  });

  it("places a card above the one it precedes", () => {
    expect(orderBetween(card({ order: 5 }), undefined)).toBe(6);
  });

  it("places a card between its neighbours without renumbering them", () => {
    // Sparse on purpose: a drop writes one number, so the rest of the column
    // is untouched.
    expect(orderBetween(card({ order: 2 }), card({ order: 4 }))).toBe(3);
  });

  it("handles an empty column", () => {
    expect(orderBetween(undefined, undefined)).toBe(0);
  });
});

describe("dropPatch", () => {
  const a = card({ order: 0, title: "a" });
  const b = card({ order: 1, title: "b" });
  const c = card({ order: 2, title: "c" });

  it("writes an order between the two neighbours at the drop point", () => {
    // c dropped between a and b: its new order must land it there.
    expect(dropPatch([a, b, c], c.id, b.id)).toEqual({ order: 0.5 });
  });

  it("writes an order that puts the card last when dropped past the end", () => {
    expect(dropPatch([a, b, c], a.id, null)).toEqual({ order: 3 });
  });

  it("refuses a drop that would not change anything", () => {
    // Dropping a card onto its own position must not produce a write.
    expect(dropPatch([a, b, c], b.id, c.id)).toBeNull();
  });

  it("ignores a card that is not in the column", () => {
    expect(dropPatch([a, b, c], "not-here", null)).toBeNull();
  });

  it("ignores a drop point that no longer exists", () => {
    expect(dropPatch([a, b, c], a.id, "gone")).toBeNull();
  });
});

describe("runAvailability", () => {
  it("allows a card with an idle bot", () => {
    expect(runAvailability(owned("Alpha"))).toEqual({ canRun: true });
  });

  it("explains that a card needs an agent before it can start", () => {
    const result = runAvailability(card());
    expect(result.canRun).toBe(false);
    expect(result.canRun === false && result.reason).toBeTruthy();
  });

  it("explains that the assigned bot is gone", () => {
    const orphan = card({ ownerBotId: "bot-1", agent: null });
    const result = runAvailability(orphan);
    expect(result.canRun).toBe(false);
    expect(result.canRun === false && result.reason).toBeTruthy();
  });

  it("explains that the bot is already on this card instead of silently doing nothing", () => {
    // The likeliest source of "the button is broken" reports, so it has to
    // name the reason rather than behaving like the needs-an-agent case.
    const busy = owned("Alpha", { agent: { id: "bot-1", name: "Worker", section: "Alpha", busy: true } });
    const result = runAvailability(busy);
    expect(result.canRun).toBe(false);
    const reason = result.canRun === false ? result.reason : "";
    const idleReason = runAvailability(owned("Alpha"));
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).not.toBe(idleReason.canRun === false ? idleReason.reason : "");
  });
});

describe("stopAvailability", () => {
  it("allows a stop only once the card has a thread of its own", () => {
    // Stopping a card that never started would reach the bot's unrelated
    // work, so the button stays off until there is a thread to name.
    expect(stopAvailability(owned("Alpha"))).toBe(false);
    expect(stopAvailability(owned("Alpha", { threadId: "thread-1" }))).toBe(true);
  });
});

describe("teamOptions", () => {
  it("always offers the unsectioned team, even when empty", () => {
    // It is where a bot lands when nobody filed it, so it must be reachable.
    const teams = teamOptions([]);
    expect(teams).toHaveLength(1);
    expect(teams[0].key).toBe("");
    expect(teams[0].count).toBe(0);
  });

  it("counts each card into exactly one team", () => {
    const teams = teamOptions([owned("Alpha"), owned("Alpha"), owned("Beta"), card()]);
    const alpha = teams.find((team) => team.key === "Alpha")!;
    expect(alpha.count).toBe(2);
    expect(teams.find((team) => team.key === "Beta")!.count).toBe(1);
    expect(teams.find((team) => team.key === "")!.count).toBe(1);
  });

  it("sorts the named teams so the switcher does not reshuffle between loads", () => {
    const teams = teamOptions([owned("Zeta"), owned("Alpha"), owned("Beta")]);
    expect(teams.slice(1).map((team) => team.label)).toEqual(["Alpha", "Beta", "Zeta"]);
  });
});

describe("cardStatusLabel", () => {
  it("says a card needs attention when it carries a failure", () => {
    // A card that stopped and said why is the most informative thing the
    // board can show, so it outranks the column it happens to sit in.
    const failed = owned("Alpha", { lastError: "boom", status: "in_progress" });
    expect(cardStatusLabel(failed)).toBe(cardStatusLabel(card({ lastError: "boom" })));
    expect(cardStatusLabel(failed)).not.toBe(cardStatusLabel(card({ status: "in_progress" })));
  });

  it("says a card is working while its bot is busy", () => {
    // The bot is genuinely mid-turn: the card says so rather than showing a
    // column that is already out of date.
    const working = owned("Alpha", { status: "todo", agent: { id: "bot-1", name: "W", busy: true } });
    expect(cardStatusLabel(working)).not.toBe(cardStatusLabel(owned("Alpha", { status: "todo" })));
  });

  it("reads each column honestly", () => {
    const labels = WORK_COLUMNS.map((status) => cardStatusLabel(card({ status })));
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(WORK_COLUMNS.length);
  });
});

describe("statusTone", () => {
  it("paints a failure as danger regardless of its column", () => {
    expect(statusTone(card({ status: "done", lastError: "boom" }))).toBe("danger");
    expect(statusTone(card({ status: "blocked" }))).toBe("danger");
  });

  it("paints finished work as success and abandoned work as idle", () => {
    expect(statusTone(card({ status: "done" }))).toBe("success");
    expect(statusTone(card({ status: "cancelled" }))).toBe("idle");
  });
});

describe("elapsedLabel", () => {
  const format = (ms: number) => `${Math.round(ms / 1_000)}s`;

  it("counts from the start while the work is running", () => {
    const running = owned("Alpha", { status: "in_progress", startedAt: 1_000, updatedAt: 9_000 });
    expect(elapsedLabel(running, 6_000, format)).toBe("5s");
  });

  it("shows when the card last changed once it is settled", () => {
    expect(elapsedLabel(card({ status: "todo", updatedAt: 4_000 }), 6_000, format)).toBe("2s");
  });

  it("shows nothing for finished work", () => {
    // A completed card's age is not a fact anyone acts on.
    expect(elapsedLabel(card({ status: "done", updatedAt: 1_000 }), 6_000, format)).toBeNull();
  });

  it("never reports a negative age", () => {
    expect(elapsedLabel(card({ status: "todo", updatedAt: 9_000 }), 1_000, format)).toBe("0s");
  });
});