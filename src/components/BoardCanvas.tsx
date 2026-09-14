// The board's canvas: the columns live on a pannable, zoomable surface that
// remembers how each viewer arranged it.
//
// Two rules shape this file.
//
// First, a drop that would land a column on top of another is REFUSED, and the
// column springs back. The Team map lets its tiles overlap, which is exactly
// the mess this is meant to avoid: a board is read at a glance, and a column
// half-hidden under another is a column whose work nobody sees. Refusing is
// also honest — pushing the other column aside would mean dragging one thing
// and silently moving a second.
//
// Second, nothing here is the board's data. Positions, sizes and names are the
// viewer's own arrangement of their screen, so they live in this browser under
// the environment's id, and clearing site data costs a layout rather than work.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";

import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { WorkColumn } from "@/lib/task-board";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clamp,
  collisions,
  contentBounds,
  defaultBoxes,
  parseLayout,
  resolveBoxes,
  type BoardLayout,
  type ColumnBox,
} from "@/lib/board-layout";

export interface BoardCanvasProps {
  children: (boxes: Record<WorkColumn, ColumnBox>, api: BoardCanvasApi) => ReactNode;
}

export interface BoardCanvasApi {
  /** Request a move. Refused when the destination would overlap. */
  move: (column: WorkColumn, box: ColumnBox) => void;
  resize: (column: WorkColumn, box: ColumnBox) => void;
  rename: (column: WorkColumn, name: string | null) => void;
  names: Partial<Record<WorkColumn, string>>;
  /** The column currently being dragged, so it can be drawn as in-flight. */
  moving: WorkColumn | null;
}

export function BoardCanvas({ children }: BoardCanvasProps) {
  useStore();
  const [boxes, setBoxes] = useState<Record<WorkColumn, ColumnBox>>(defaultBoxes);
  const [names, setNames] = useState<Partial<Record<WorkColumn, string>>>({});
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [moving, setMoving] = useState<WorkColumn | null>(null);
  const [refused, setRefused] = useState<WorkColumn | null>(null);
  const storageKey = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ startX: number; startY: number; view: { x: number; y: number } } | null>(null);

  /** Layout is personal presentation, not board data. Keying it to the
   * workspace id keeps two hosted workspaces from sharing an arrangement —
   * the same key shape the Team map uses. */
  useEffect(() => {
    let active = true;
    void api("/.well-known/openmausbot/environment", { signal: AbortSignal.timeout(5_000) })
      .then((environment) => {
        if (!active || typeof environment.environmentId !== "string") return;
        storageKey.current = `omb-task-board-layout:${environment.environmentId}`;
        try {
          const saved = parseLayout(localStorage.getItem(storageKey.current));
          setNames(saved.names ?? {});
          setBoxes(resolveBoxes(saved.boxes));
          if (saved.view) setView(saved.view);
        } catch {
          /* Private browsing may disable storage; the board still works. */
        }
      })
      .catch(() => {
        /* An older companion can use the board without persistence. */
      });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback((layout: BoardLayout) => {
    if (!storageKey.current) return;
    try {
      localStorage.setItem(storageKey.current, JSON.stringify(layout));
    } catch {
      /* A full or disabled store must not stop someone arranging their board. */
    }
  }, []);

  const persist = useCallback(
    (nextBoxes: Record<WorkColumn, ColumnBox>, nextNames = names, nextView = view) => {
      save({ boxes: nextBoxes, names: nextNames, view: nextView });
    },
    [names, save, view],
  );

  /** A move is a REQUEST. It lands only if the destination is clear, so the
   * board cannot be arranged into a pile. */
  const move = useCallback(
    (column: WorkColumn, box: ColumnBox) => {
      setBoxes((current) => {
        const hit = collisions(column, box, current);
        if (hit.length) {
          setRefused(column);
          // Nothing changes: the column stays where it was and the canvas
          // shows why. Moving it and moving it back would look like a glitch.
          return current;
        }
        setRefused(null);
        setMoving(column);
        const next = { ...current, [column]: box };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const resize = useCallback(
    (column: WorkColumn, box: ColumnBox) => {
      setBoxes((current) => {
        // A resize can also collide — grown into a neighbour — so it obeys the
        // same rule as a move rather than being trusted because it is smaller
        // in appearance.
        if (collisions(column, box, current).length) {
          setRefused(column);
          return current;
        }
        setRefused(null);
        const next = { ...current, [column]: box };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const rename = useCallback(
    (column: WorkColumn, name: string | null) => {
      setNames((current) => {
        const next = { ...current };
        if (name) next[column] = name;
        else delete next[column];
        persist(boxes, next);
        return next;
      });
    },
    [boxes, persist],
  );

  /** Clear the "refused" flag once the column stops being dragged, so the
   * warning is about the gesture and not a permanent mark. */
  useEffect(() => {
    if (!refused) return;
    const timer = window.setTimeout(() => setRefused(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [refused]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = contentBounds(boxes);
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const padding = 32;
    const scale = clamp(
      Math.min(
        (viewport.clientWidth - padding * 2) / bounds.width,
        (viewport.clientHeight - padding * 2) / bounds.height,
      ),
      MIN_ZOOM,
      1,
    );
    setView({
      x: padding - bounds.left * scale,
      y: padding - bounds.top * scale,
      scale,
    });
  }, [boxes]);

  // Centre the board on first paint, once the saved layout has arrived.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    const timer = window.setTimeout(fit, 60);
    return () => window.clearTimeout(timer);
  }, [fit]);

  /** Wheel: Ctrl/Cmd zooms about the cursor, plain wheel pans. Matching the
   * Team map means the gesture people have learned there works here. */
  const onWheel = (event: React.WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const pointX = event.clientX - rect.left;
      const pointY = event.clientY - rect.top;
      const next = clamp(view.scale * (event.deltaY < 0 ? 1.1 : 0.9), MIN_ZOOM, MAX_ZOOM);
      // Keep the point under the cursor fixed while the scale changes.
      const ratio = next / view.scale;
      setView({
        scale: next,
        x: pointX - (pointX - view.x) * ratio,
        y: pointY - (pointY - view.y) * ratio,
      });
      return;
    }
    setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
  };

  /** Dragging empty canvas pans it. The columns handle their own drags and
   * stop propagation, so this only ever sees the background. */
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-column]")) return;
    pan.current = { startX: event.clientX, startY: event.clientY, view: { x: view.x, y: view.y } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const active = pan.current;
    if (!active) return;
    setView((current) => ({
      ...current,
      x: active.view.x + (event.clientX - active.startX),
      y: active.view.y + (event.clientY - active.startY),
    }));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!pan.current) return;
    pan.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    persist(boxes, names, view);
  };

  const zoomBy = (factor: number) => {
    setView((current) => ({ ...current, scale: clamp(current.scale * factor, MIN_ZOOM, MAX_ZOOM) }));
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative h-full w-full touch-none overflow-hidden outline-none"
        style={{
          backgroundImage:
            "radial-gradient(circle, color-mix(in srgb, var(--color-ink-secondary) 16%, transparent) 1px, transparent 1px)",
          backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {children(boxes, { move, resize, rename, names, moving })}
        </div>
      </div>

      {/* The canvas' own controls, floating over it rather than in the header:
          zoom belongs to the surface you are zooming. */}
      <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-xl border border-hairline/60 bg-panel p-1 shadow-sm">
        <button
          type="button"
          onClick={() => zoomBy(0.9)}
          aria-label={t("taskBoard.canvas.zoomOut")}
          title={t("taskBoard.canvas.zoomOut")}
          className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          onClick={fit}
          aria-label={t("taskBoard.canvas.fit")}
          title={t("taskBoard.canvas.fit")}
          className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1.1)}
          aria-label={t("taskBoard.canvas.zoomIn")}
          title={t("taskBoard.canvas.zoomIn")}
          className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Plus size={14} />
        </button>
      </div>

      {refused && (
        <p
          role="status"
          className="animate-pop-in pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-[12px] text-warning shadow-sm"
        >
          {t("taskBoard.canvas.overlap", { name: refused })}
        </p>
      )}
    </div>
  );
}