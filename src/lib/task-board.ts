// The board's own logic, with no React in it.
//
// Everything here answers a question about the cards a client has already
// fetched: which team is showing, what each column holds, what a drag does to
// the order, and what a card is trying to tell you about itself. Keeping it
// pure means the interesting cases — a card with no owner, a card whose bot
// was deleted, a drop between two neighbours — are testable without a DOM,
// and the components stay a description of what to draw.
//
// The rules mirror the server's, deliberately: the board arrives already
// filtered by team, but a `?team=` request races a bot being reassigned, so
// the client re-applies the same predicate rather than trusting a snapshot.
import { t } from "@/lib/i18n";

/** Where a card shows on the board, left to right. The order is the board's
 * layout, so it lives here rather than in each component. */
export const WORK_COLUMNS = ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"] as const;

export type WorkColumn = (typeof WORK_COLUMNS)[number];

export interface BoardAgent {
  id: string;
  name: string;
  section?: string;
  activity?: string;
  busy?: boolean;
  hidden?: boolean;
}

export interface BoardCard {
  id: string;
  boardId?: string;
  title: string;
  brief?: string;
  status: WorkColumn;
  order: number;
  ownerBotId?: string;
  threadId?: string;
  routineId?: string;
  origin?: "manual" | "routine";
  artifacts?: Array<{ kind: string; ref: string; label?: string }>;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  lastError?: string;
  /** What the server reported about the card's owner, already reduced to the
   * team the card belongs to. Absent when the card has no owner. */
  agent?: BoardAgent | null;
}

/** Which team a card belongs to, as the server computes it.
 *
 * A card reaches a team through its owner's section, and a card with no
 * visible owner falls to the unsectioned team. It must never belong to two
 * teams at once, so this is the single place that decides. */
export function cardSection(card: BoardCard): string {
  const owner = card.agent;
  if (!owner || owner.hidden) return "";
  return owner.section?.trim() ?? "";
}

/** The team a filter string names. `null` is "no filter", which is not the
 * same as `""` — the empty key is the unsectioned team, a real selection. */
export function filterByTeam(cards: BoardCard[], team: string | null): BoardCard[] {
  if (team === null) return cards;
  return cards.filter((card) => cardSection(card) === team);
}

/** Cards grouped into their columns, each column ordered for display.
 *
 * Order is `order` ascending, which is what a drop writes; ties fall back to
 * the newest first so a card created at the same order still lands somewhere
 * stable instead of wherever the sort happens to put it. */
export function columnsOf(cards: BoardCard[]): Record<WorkColumn, BoardCard[]> {
  const columns = Object.fromEntries(WORK_COLUMNS.map((column) => [column, [] as BoardCard[]])) as Record<
    WorkColumn,
    BoardCard[]
  >;
  for (const card of cards) {
    // A card whose status this client does not know about is not lost: it
    // lands in the first column rather than vanishing from every column.
    (columns[card.status] ?? columns.backlog).push(card);
  }
  for (const column of WORK_COLUMNS) {
    columns[column].sort((a, b) => a.order - b.order || b.createdAt - a.createdAt);
  }
  return columns;
}

/** The order value a drop between two neighbours should write.
 *
 * Sparse on purpose: a drop writes one number rather than renumbering the
 * column, so the neighbours' own orders stay untouched. */
export function orderBetween(before: BoardCard | undefined, after: BoardCard | undefined): number {
  if (!before && !after) return 0;
  if (!before) return (after as BoardCard).order - 1;
  if (!after) return before.order + 1;
  return (before.order + after.order) / 2;
}

/** A card's position in its column after `dragged` is dropped where `beforeId`
 * now sits. Returns the patch to send, or null when nothing would change — a
 * drop onto itself must not produce a write. */
export function dropPatch(
  column: BoardCard[],
  draggedId: string,
  beforeId: string | null,
): { order: number } | null {
  const dragged = column.find((card) => card.id === draggedId);
  if (!dragged) return null;
  const rest = column.filter((card) => card.id !== draggedId);
  const at = beforeId === null ? rest.length : rest.findIndex((card) => card.id === beforeId);
  if (at === -1) return null;
  const order = orderBetween(at > 0 ? rest[at - 1] : undefined, rest[at]);
  return order === dragged.order ? null : { order };
}

/** What a card is trying to say about the work right now, in one phrase.
 *
 * The order matters: a failure outranks a running agent, because a card that
 * stopped and said why is more informative than one that merely looks busy. */
export function cardStatusLabel(card: BoardCard): string {
  if (card.lastError) return t("taskBoard.card.failed");
  if (card.agent?.busy) return t("taskBoard.card.working");
  switch (card.status) {
    case "backlog":
      return t("taskBoard.card.backlog");
    case "todo":
      return t("taskBoard.card.todo");
    case "in_progress":
      return t("taskBoard.card.inProgress");
    case "blocked":
      return t("taskBoard.card.blocked");
    case "done":
      return t("taskBoard.card.done");
    case "cancelled":
      return t("taskBoard.card.cancelled");
  }
}

/** The colour a status chip uses, as the rest of the app names its tones. */
export function statusTone(card: BoardCard): "success" | "warning" | "danger" | "accent" | "idle" {
  if (card.lastError || card.status === "blocked") return "danger";
  if (card.status === "done") return "success";
  if (card.status === "cancelled") return "idle";
  if (card.agent?.busy || card.status === "in_progress") return "accent";
  return "warning";
}

/** Whether Run can be pressed, and why not when it cannot.
 *
 * The board is where the person looking at the button is, so a disabled
 * button always says what is missing rather than being inert. */
export function runAvailability(card: BoardCard):
  | { canRun: true }
  | { canRun: false; reason: string } {
  if (!card.ownerBotId) return { canRun: false, reason: t("taskBoard.run.needsAgent") };
  if (!card.agent) return { canRun: false, reason: t("taskBoard.run.agentGone") };
  if (card.agent.busy) return { canRun: false, reason: t("taskBoard.run.alreadyWorking") };
  return { canRun: true };
}

/** Whether Stop can be pressed. Stopping a card that never started would
 * reach the bot's unrelated work, so the card must have a thread of its own
 * and something must actually be running on it. */
export function stopAvailability(card: BoardCard): boolean {
  return Boolean(card.threadId) && Boolean(card.agent);
}

/** The teams a switcher shows, derived from the cards rather than a second
 * request. The unsectioned team is always offered — it is where a bot lands
 * when nobody filed it, so it must be reachable even while it is empty. */
export function teamOptions(cards: BoardCard[]): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const key = cardSection(card);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const named = [...counts]
    .filter(([key]) => key !== "")
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ key: "", label: t("taskBoard.team.general"), count: counts.get("") ?? 0 }, ...named];
}

/** Time a card has been running, or how long ago it settled. Kept as a plain
 * phrase so the card never has to reason about durations itself. */
export function elapsedLabel(card: BoardCard, now: number, format: (ms: number) => string): string | null {
  if (card.startedAt && (card.status === "in_progress" || card.agent?.busy)) {
    return format(Math.max(0, now - card.startedAt));
  }
  if (card.status === "done" || card.status === "cancelled") return null;
  return format(Math.max(0, now - card.updatedAt));
}