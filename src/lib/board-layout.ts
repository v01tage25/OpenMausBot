// Where the board's columns sit, how big they are, and what they are called.
//
// All three are the viewer's own arrangement of their screen, so all three are
// kept in the browser rather than on the server — the same choice the Team map
// makes for its tiles, and for the same reason: two people looking at the same
// board are allowed to want different layouts, and clearing a cache should not
// change what the work is, only how it is drawn.
//
// The rules live here rather than in the canvas so the interesting cases —
// a corrupt entry, a size dragged to nothing, a drop that would land on top of
// another column — are testable without a DOM.
import { WORK_COLUMNS, type WorkColumn } from "./task-board";

/** A column's box on the canvas, in world coordinates. */
export interface ColumnBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything a viewer may change about how the board is laid out. */
export interface BoardLayout {
  /** Column order and identifiers, left to right. A saved layout keeps the
   * canonical set: these keys are the board's own, not free text. */
  names?: Partial<Record<WorkColumn, string>>;
  boxes?: Partial<Record<WorkColumn, ColumnBox>>;
  /** Pan/zoom, so reopening the board lands where it was left. */
  view?: { x: number; y: number; scale: number };
}

export const DEFAULT_COLUMN_WIDTH = 300;
export const DEFAULT_COLUMN_HEIGHT = 420;

/** Bounds a column may be dragged to. The minimum is the size below which a
 * card stops being readable — a title needs roughly this much — and the
 * maximum stops a stray drag from producing a column kilometres wide that the
 * viewer then has to hunt for. */
export const MIN_COLUMN_WIDTH = 220;
export const MIN_COLUMN_HEIGHT = 220;
export const MAX_COLUMN_WIDTH = 900;
export const MAX_COLUMN_HEIGHT = 2000;

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 1.5;

/** Gap between columns in the default arrangement, matching the grid's old
 * spacing so an existing board looks the same on first load. */
export const COLUMN_GAP = 16;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The arrangement a viewer who has never dragged anything sees: the board's
 * own left-to-right order, laid out in one row.
 *
 * This is deliberately the order the columns have always been in. A saved
 * layout is an opt-in — nothing about a person's first visit should depend on
 * the canvas existing. */
export function defaultBoxes(): Record<WorkColumn, ColumnBox> {
  const boxes = {} as Record<WorkColumn, ColumnBox>;
  WORK_COLUMNS.forEach((column, index) => {
    boxes[column] = {
      x: index * (DEFAULT_COLUMN_WIDTH + COLUMN_GAP),
      y: 0,
      width: DEFAULT_COLUMN_WIDTH,
      height: DEFAULT_COLUMN_HEIGHT,
    };
  });
  return boxes;
}

/** Whether two column boxes overlap. Touching edges do not count — a column
 * butted exactly against its neighbour is arranged, not colliding. */
export function boxesOverlap(a: ColumnBox, b: ColumnBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** The columns a moved box would land on, if any.
 *
 * The canvas refuses these drops rather than nudging the other column aside:
 * a board where dragging one column silently moves another is a board that
 * fights the person arranging it, and the Team map's free-for-all is exactly
 * the behaviour this is meant to avoid. */
export function collisions(
  moved: WorkColumn,
  box: ColumnBox,
  boxes: Record<WorkColumn, ColumnBox>,
): WorkColumn[] {
  return WORK_COLUMNS.filter(
    (column) => column !== moved && boxesOverlap(box, boxes[column]),
  );
}

/** Whether a box is a sane thing to draw: finite, positive, inside bounds. */
export function validBox(value: unknown): value is ColumnBox {
  if (!value || typeof value !== "object") return false;
  const box = value as Record<string, unknown>;
  const numbers = [box.x, box.y, box.width, box.height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  // A saved position is a place on an effectively infinite plane, but a
  // nonsensical one is dropped rather than trusted — the same guard the Team
  // map applies to its saved positions.
  if (Math.abs(box.x as number) > 100_000 || Math.abs(box.y as number) > 100_000) return false;
  return (box.width as number) > 0 && (box.height as number) > 0;
}

/** Read a saved layout. Anything unreadable is dropped rather than repaired:
 * a partly-corrupt layout should cost the viewer their arrangement, not the
 * board. */
export function parseLayout(raw: string | null): BoardLayout {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const source = parsed as Record<string, unknown>;
  const layout: BoardLayout = {};

  const names = source.names;
  if (names && typeof names === "object") {
    const kept: Partial<Record<WorkColumn, string>> = {};
    for (const column of WORK_COLUMNS) {
      const value = (names as Record<string, unknown>)[column];
      // A rename is a label, not a document: trimmed, bounded, and ignoring
      // anything that is not a string.
      if (typeof value === "string" && value.trim()) kept[column] = value.trim().slice(0, 40);
    }
    layout.names = kept;
  }

  const boxes = source.boxes;
  if (boxes && typeof boxes === "object") {
    const kept: Partial<Record<WorkColumn, ColumnBox>> = {};
    for (const column of WORK_COLUMNS) {
      const value = (boxes as Record<string, unknown>)[column];
      if (validBox(value)) {
        kept[column] = {
          x: value.x,
          y: value.y,
          width: clamp(value.width, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH),
          height: clamp(value.height, MIN_COLUMN_HEIGHT, MAX_COLUMN_HEIGHT),
        };
      }
    }
    layout.boxes = kept;
  }

  const view = source.view;
  if (view && typeof view === "object") {
    const { x, y, scale } = view as Record<string, unknown>;
    if (
      typeof x === "number" && Number.isFinite(x) &&
      typeof y === "number" && Number.isFinite(y) &&
      typeof scale === "number" && Number.isFinite(scale)
    ) {
      layout.view = { x, y, scale: clamp(scale, MIN_ZOOM, MAX_ZOOM) };
    }
  }

  return layout;
}

/** Fill a saved layout out to a complete board: every column has a box, and
 * any the viewer never moved keeps its default place. */
export function resolveBoxes(saved: Partial<Record<WorkColumn, ColumnBox>> | undefined): Record<WorkColumn, ColumnBox> {
  return { ...defaultBoxes(), ...(saved ?? {}) };
}

/** A column's title: the viewer's own name for it if they set one, otherwise
 * the label the app supplies. This is the single place that decides, so the
 * canvas and anything else drawing a column cannot disagree. */
export function columnTitle(
  column: WorkColumn,
  names: Partial<Record<WorkColumn, string>> | undefined,
  fallback: (column: WorkColumn) => string,
): string {
  const custom = names?.[column]?.trim();
  return custom || fallback(column);
}

/** Where a column lands when its box is resized from a given corner.
 *
 * Resizing from the left or top edge has to move the origin as well as the
 * size, or the column would grow to the right while the handle is dragged to
 * the left. `edge` names the corner being pulled. */
export type ResizeEdge = "right" | "bottom" | "corner" | "left" | "top";

export function resizeBox(
  box: ColumnBox,
  edge: ResizeEdge,
  deltaX: number,
  deltaY: number,
): ColumnBox {
  let { x, y, width, height } = box;

  if (edge === "right" || edge === "corner") {
    width = clamp(width + deltaX, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
  }
  if (edge === "bottom" || edge === "corner") {
    height = clamp(height + deltaY, MIN_COLUMN_HEIGHT, MAX_COLUMN_HEIGHT);
  }
  if (edge === "left") {
    // Moving the left edge changes both the origin and the width; the right
    // edge stays put, which is what makes the gesture feel attached to the
    // handle rather than to the column.
    const right = box.x + box.width;
    width = clamp(box.width - deltaX, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
    x = right - width;
  }
  if (edge === "top") {
    const bottom = box.y + box.height;
    height = clamp(box.height - deltaY, MIN_COLUMN_HEIGHT, MAX_COLUMN_HEIGHT);
    y = bottom - height;
  }

  return { x, y, width, height };
}

/** The bounding box of every column, for fitting the view. */
export function contentBounds(boxes: Record<WorkColumn, ColumnBox>) {
  const values = WORK_COLUMNS.map((column) => boxes[column]);
  const left = Math.min(...values.map((box) => box.x));
  const top = Math.min(...values.map((box) => box.y));
  const right = Math.max(...values.map((box) => box.x + box.width));
  const bottom = Math.max(...values.map((box) => box.y + box.height));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}