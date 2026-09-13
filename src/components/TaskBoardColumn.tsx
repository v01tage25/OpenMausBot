// One column of the board, and the drop target for cards dragged onto it.
//
// Dropping a card moves it; it never starts it. That is the whole reason this
// component exists separately from the card: an agent that began working the
// moment a card was dragged into "In progress" would be work nobody asked
// for, triggered by a gesture that can happen by accident.
//
// A drop writes the same PATCH any other edit writes. The new order is one
// number placed between its neighbours, so the rest of the column is not
// renumbered and two people dragging at once do not fight over a whole list.
import { useState, type DragEvent } from "react";

import { TaskBoardCardView } from "./TaskBoardCard";
import { CARD_DRAG_TYPE, type TaskBoardCardProps } from "./TaskBoardCard";
import { t } from "@/lib/i18n";
import type { BoardCard } from "@/lib/task-board";
import { cn } from "@/lib/cn";

export interface TaskBoardColumnProps {
  title: string;
  /** Shown in the header. Passed in rather than counted here, because the
   * header must agree with the list the page actually handed over — including
   * when a card arrives from another column mid-render. */
  count: number;
  cards: BoardCard[];
  renderCard: (card: BoardCard) => Omit<TaskBoardCardProps, "card">;
  onDrop: (cardId: string, beforeId: string | null) => void;
}

export function TaskBoardColumn({
  title,
  count,
  cards,
  renderCard,
  onDrop,
}: TaskBoardColumnProps) {
  const [over, setOver] = useState(false);

  /** Whether a drag carries one of THIS board's cards. A sidebar folder uses
   * its own type, and must not be treated as a card just because it is being
   * dragged across the same window. */
  const accepts = (event: DragEvent<HTMLElement>) =>
    event.dataTransfer.types.includes(CARD_DRAG_TYPE);

  const handleOver = (event: DragEvent<HTMLElement>) => {
    if (!accepts(event)) return;
    // Calling preventDefault is what marks this a valid drop target; without
    // it the browser rejects the drop and the card snaps back with no reason.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(true);
  };

  const handleDrop = (event: DragEvent<HTMLElement>, beforeId: string | null) => {
    if (!accepts(event)) return;
    event.preventDefault();
    setOver(false);
    const cardId = event.dataTransfer.getData(CARD_DRAG_TYPE);
    if (cardId) onDrop(cardId, beforeId);
  };

  return (
    <section
      onDragOver={handleOver}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => handleDrop(event, null)}
      className={cn(
        // Width comes from the grid that lays the columns out, never from a
        // fixed size here: a column that insisted on 268px pushed the last
        // ones past the window edge with no way to reach them.
        "flex min-h-0 min-w-0 flex-col rounded-2xl border bg-panel/60 p-2.5 transition",
        over ? "border-accent/45 bg-accent/5" : "border-hairline/40",
      )}
      aria-label={title}
    >
      <header className="mb-2 flex items-center justify-between px-1.5">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{title}</h2>
        <span className="shrink-0 text-[10.5px] tabular-nums text-ink-secondary/70">{count}</span>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-0.5 pb-1">
        {cards.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-ink-secondary/55">{t("taskBoard.emptyColumn")}</p>
        )}
        {cards.map((card, index) => (
          <div
            key={card.id}
            onDragOver={(event) => {
              if (!accepts(event)) return;
              // Dropping ON a card means "put it here", which is how a card
              // lands between two others instead of only at the end.
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.stopPropagation();
              handleDrop(event, card.id);
            }}
          >
            <TaskBoardCardView card={card} {...renderCard(card)} appearIndex={index} />
          </div>
        ))}
      </div>
    </section>
  );
}