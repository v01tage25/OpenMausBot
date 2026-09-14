// The layout's rules, without a DOM.
//
// These exist because the expensive failures here are the quiet ones: a saved
// layout that half-loads and scatters the board, a resize that shrinks a
// column until its cards are unreadable, or a drop that lands on top of
// another column — which is the one thing the canvas must not allow, and the
// exact behaviour the Team map has that this is meant to avoid.
import { describe, expect, it } from "vitest";

import {
  COLUMN_GAP,
  DEFAULT_COLUMN_HEIGHT,
  DEFAULT_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  MAX_ZOOM,
  MIN_COLUMN_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ZOOM,
  boxesOverlap,
  clamp,
  collisions,
  columnTitle,
  contentBounds,
  defaultBoxes,
  parseLayout,
  resizeBox,
  resolveBoxes,
  validBox,
} from "./board-layout";
import { WORK_COLUMNS, type WorkColumn } from "./task-board";

const label = (column: WorkColumn) => column.toUpperCase();

describe("defaultBoxes", () => {
  it("lays the columns out in the board's own order, left to right", () => {
    const boxes = defaultBoxes();
    // A viewer who has never dragged anything must see the arrangement the
    // board has always had, not something the canvas invented.
    const xs = WORK_COLUMNS.map((column) => boxes[column].x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(boxes.backlog.x).toBe(0);
    expect(boxes.todo.x).toBe(DEFAULT_COLUMN_WIDTH + COLUMN_GAP);
  });

  it("gives every column the same starting size", () => {
    const boxes = defaultBoxes();
    for (const column of WORK_COLUMNS) {
      expect(boxes[column].width).toBe(DEFAULT_COLUMN_WIDTH);
      expect(boxes[column].height).toBe(DEFAULT_COLUMN_HEIGHT);
    }
  });

  it("never overlaps itself", () => {
    const boxes = defaultBoxes();
    for (const a of WORK_COLUMNS) {
      for (const b of WORK_COLUMNS) {
        if (a === b) continue;
        expect(boxesOverlap(boxes[a], boxes[b])).toBe(false);
      }
    }
  });
});

describe("boxesOverlap", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };

  it("detects a real overlap", () => {
    expect(boxesOverlap(box, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
  });

  it("treats touching edges as arranged, not colliding", () => {
    // A column butted exactly against its neighbour is laid out on purpose.
    expect(boxesOverlap(box, { x: 100, y: 0, width: 100, height: 100 })).toBe(false);
    expect(boxesOverlap(box, { x: 0, y: 100, width: 100, height: 100 })).toBe(false);
  });

  it("does not consider a diagonal neighbour an overlap", () => {
    expect(boxesOverlap(box, { x: 100, y: 100, width: 100, height: 100 })).toBe(false);
  });
});

describe("collisions", () => {
  it("names the column a drop would land on", () => {
    const boxes = defaultBoxes();
    const moved = { ...boxes.todo, x: boxes.backlog.x + 10, y: boxes.backlog.y };
    expect(collisions("todo", moved, boxes)).toEqual(["backlog"]);
  });

  it("reports every column hit, not just the first", () => {
    const boxes = defaultBoxes();
    // A wide box straddling the whole row genuinely overlaps more than one.
    const moved = { x: -10, y: 0, width: 5000, height: DEFAULT_COLUMN_HEIGHT };
    const hit = collisions("done", moved, boxes);
    expect(hit).toContain("backlog");
    expect(hit).toContain("todo");
    expect(hit).not.toContain("done");
  });

  it("finds nothing when a column is dropped in clear space", () => {
    const boxes = defaultBoxes();
    const moved = { ...boxes.blocked, y: boxes.blocked.y + DEFAULT_COLUMN_HEIGHT + COLUMN_GAP };
    expect(collisions("blocked", moved, boxes)).toEqual([]);
  });
});

describe("resizeBox", () => {
  const box = { x: 100, y: 100, width: 300, height: 400 };

  it("grows from the right and bottom edges without moving the origin", () => {
    expect(resizeBox(box, "right", 40, 0)).toEqual({ x: 100, y: 100, width: 340, height: 400 });
    expect(resizeBox(box, "bottom", 0, 60)).toEqual({ x: 100, y: 100, width: 300, height: 460 });
  });

  it("keeps the opposite edge fixed when dragged from the left or top", () => {
    // The right edge must not move, or the column slides away from the handle
    // the person is holding.
    const left = resizeBox(box, "left", -50, 0);
    expect(left.width).toBe(350);
    expect(left.x + left.width).toBe(box.x + box.width);

    const top = resizeBox(box, "top", 0, -30);
    expect(top.height).toBe(430);
    expect(top.y + top.height).toBe(box.y + box.height);
  });

  it("moves both axes from the corner", () => {
    const corner = resizeBox(box, "corner", 20, 30);
    expect(corner).toEqual({ x: 100, y: 100, width: 320, height: 430 });
  });

  it("refuses to shrink a column until its cards stop being readable", () => {
    const tiny = resizeBox(box, "corner", -10_000, -10_000);
    expect(tiny.width).toBe(MIN_COLUMN_WIDTH);
    expect(tiny.height).toBe(MIN_COLUMN_HEIGHT);
  });

  it("refuses to grow a column without limit", () => {
    const huge = resizeBox(box, "corner", 100_000, 100_000);
    expect(huge.width).toBe(MAX_COLUMN_WIDTH);
  });
});

describe("validBox", () => {
  it("accepts a plain box", () => {
    expect(validBox({ x: 0, y: 0, width: 300, height: 400 })).toBe(true);
  });

  it("rejects anything a corrupt save could contain", () => {
    expect(validBox(null)).toBe(false);
    expect(validBox({ x: 0, y: 0, width: 300 })).toBe(false);
    expect(validBox({ x: 0, y: 0, width: "300", height: 400 })).toBe(false);
    expect(validBox({ x: Number.NaN, y: 0, width: 300, height: 400 })).toBe(false);
    expect(validBox({ x: 0, y: 0, width: 0, height: 400 })).toBe(false);
    // A position so far out it cannot be a real arrangement.
    expect(validBox({ x: 999_999, y: 0, width: 300, height: 400 })).toBe(false);
  });
});

describe("parseLayout", () => {
  it("returns nothing for a missing or unreadable layout", () => {
    expect(parseLayout(null)).toEqual({});
    expect(parseLayout("not json")).toEqual({});
    expect(parseLayout("[]")).toEqual({});
  });

  it("keeps a valid arrangement", () => {
    const saved = JSON.stringify({
      names: { blocked: "Needs help" },
      boxes: { todo: { x: 10, y: 20, width: 320, height: 380 } },
      view: { x: 5, y: 6, scale: 0.8 },
    });
    const layout = parseLayout(saved);
    expect(layout.names?.blocked).toBe("Needs help");
    expect(layout.boxes?.todo).toEqual({ x: 10, y: 20, width: 320, height: 380 });
    expect(layout.view).toEqual({ x: 5, y: 6, scale: 0.8 });
  });

  it("drops a corrupt column without losing the rest", () => {
    // The failure worth designing for: one bad entry costing the whole board.
    const saved = JSON.stringify({
      names: { backlog: "Ideas" },
      boxes: {
        todo: { x: 10, y: 20, width: 320, height: 380 },
        done: { x: "nope", y: 0, width: 300, height: 400 },
      },
    });
    const layout = parseLayout(saved);
    expect(layout.names?.backlog).toBe("Ideas");
    expect(Object.keys(layout.boxes ?? {})).toEqual(["todo"]);
  });

  it("ignores names for columns that are not the board's own", () => {
    const saved = JSON.stringify({ names: { backlog: "Ideas", "drop-table": "evil" } });
    const layout = parseLayout(saved);
    expect(Object.keys(layout.names ?? {})).toEqual(["backlog"]);
  });

  it("bounds a rename rather than storing a paragraph", () => {
    const long = "x".repeat(500);
    const layout = parseLayout(JSON.stringify({ names: { backlog: long } }));
    expect(layout.names?.backlog).toHaveLength(40);
  });

  it("drops a blank rename instead of hiding the column's real label", () => {
    const layout = parseLayout(JSON.stringify({ names: { backlog: "   " } }));
    expect(layout.names?.backlog).toBeUndefined();
  });

  it("clamps a saved size into range rather than trusting it", () => {
    const saved = JSON.stringify({ boxes: { todo: { x: 0, y: 0, width: 9999, height: 5 } } });
    const layout = parseLayout(saved);
    expect(layout.boxes?.todo?.width).toBe(MAX_COLUMN_WIDTH);
    expect(layout.boxes?.todo?.height).toBe(MIN_COLUMN_HEIGHT);
  });

  it("clamps a saved zoom into range", () => {
    expect(parseLayout(JSON.stringify({ view: { x: 0, y: 0, scale: 99 } })).view?.scale).toBe(MAX_ZOOM);
    expect(parseLayout(JSON.stringify({ view: { x: 0, y: 0, scale: 0.001 } })).view?.scale).toBe(MIN_ZOOM);
  });

  it("drops a view with a missing or unreadable part", () => {
    expect(parseLayout(JSON.stringify({ view: { x: 0, y: 0 } })).view).toBeUndefined();
    expect(parseLayout(JSON.stringify({ view: { x: "a", y: 0, scale: 1 } })).view).toBeUndefined();
  });
});

describe("resolveBoxes", () => {
  it("fills the columns the viewer never moved with their default place", () => {
    const resolved = resolveBoxes({ todo: { x: 500, y: 0, width: 260, height: 300 } });
    expect(resolved.todo.x).toBe(500);
    expect(resolved.backlog).toEqual(defaultBoxes().backlog);
    expect(Object.keys(resolved).sort()).toEqual([...WORK_COLUMNS].sort());
  });

  it("gives the default arrangement when nothing was saved", () => {
    expect(resolveBoxes(undefined)).toEqual(defaultBoxes());
  });
});

describe("columnTitle", () => {
  it("prefers the viewer's own name", () => {
    expect(columnTitle("blocked", { blocked: "Needs help" }, label)).toBe("Needs help");
  });

  it("falls back to the app's label when nothing was renamed", () => {
    expect(columnTitle("blocked", {}, label)).toBe("BLOCKED");
    expect(columnTitle("blocked", undefined, label)).toBe("BLOCKED");
  });

  it("ignores a rename that is only whitespace", () => {
    expect(columnTitle("blocked", { blocked: "   " }, label)).toBe("BLOCKED");
  });
});

describe("contentBounds", () => {
  it("spans every column", () => {
    const bounds = contentBounds(defaultBoxes());
    expect(bounds.left).toBe(0);
    expect(bounds.top).toBe(0);
    expect(bounds.right).toBe(WORK_COLUMNS.length * DEFAULT_COLUMN_WIDTH + (WORK_COLUMNS.length - 1) * COLUMN_GAP);
    expect(bounds.height).toBe(DEFAULT_COLUMN_HEIGHT);
  });
});

describe("clamp", () => {
  it("holds a value inside its range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});