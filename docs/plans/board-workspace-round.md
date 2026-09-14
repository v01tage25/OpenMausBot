# Board workspace round: markdown briefs, canvas columns, rename, resize

**Status:** agreed 2026-09-14, not yet built. This is the working checklist for the
next round, so "what is still missing" has one answer in one place.

Supersedes nothing; extends `task-board-dates-multibot-todos.md`, which holds the
still-unbuilt dates / multi-bot / checklist work.

---

## Agreed decisions

| # | Decision |
|---|---|
| 1 | **Markdown briefs, not a WYSIWYG editor.** The brief is stored as markdown and rendered with the existing `ChatMarkdown` (react-markdown + remark-gfm: bold, italics, lists, tables, code). No editor dependency is added, and the text the bot reads stays plain. |
| 3 | **Canvas with collision rules (§A).** Columns live on a pannable/zoomable canvas like the Team map, but a drop that would intersect another column is refused — the Team map has no collision handling, so this is new work, not a port. |
| 6 | **Columns resize, and it persists** (§B). Width and height are draggable and remembered. |
| 3-ord | Default layout for a fresh board is the **current left-to-right order** (Backlog → To do → In progress → Blocked → Done → Cancelled), so nothing moves for an existing user. |
| 4 | **Click a column title to rename**, persisted, with a discoverable affordance. |
| 5 | **Restyle** cards and columns toward the Team map's look. |
| 7 | Dead code audited and removed; **re-audit after this round** (user asked explicitly). |
| 8 | **Copywriter pass on board titles/strings only** — friendly, human wording. No marketing gloss, no invented claims. English strings proposed for approval, then applied to all 9 locales. |

Explicitly **not** wanted: rich-text editor (§1), separate todo list (§1 of the other doc).

---

## What is already done (this session)

- Card no longer hangs in progress when its bot errors — settles on turn end.
- Run clock starts on start, stops on finish; no clock for a card that never ran.
- Each bot's own avatar colour in the picker and on cards.
- Open-chat icon matches the Team map.
- Board takes the whole window with its own back arrow; column widths re-tuned.
- Caret no longer stolen while typing in the editor; picker focus hardened the same way.
- A failed card's bot shows its **alert face**, like everywhere else in the app.
- Two dead helpers removed (`teamOptions`, `isWorkOrigin`).

## Still to build (this round)

1. Markdown rendering for the brief (card + editor), with a small formatting hint in
   the editor so the syntax is discoverable.
2. Canvas columns: pan/zoom, drag to place, **intersection refused**, order preserved on
   first run. Positions persist.
3. Resizable columns: width + height by dragging an edge, persisted.
4. Rename a column by clicking its title; persisted; visible affordance (pencil on hover).
5. Restyle cards/columns toward the Team map (`rounded-2xl`, `bg-panel/90`, `shadow-sm`,
   hairline borders).
6. Copywriter pass on strings (proposal first).
7. Re-audit for dead code after the above.

## Still to build (from the earlier doc, unchanged)

- Card checklist, with all-done → Done and its guardrails.
- `dueAt` (display-only) and `runAt` armed by the To-do column.
- Multi-bot assignment → group chat, including the open question about whether a
  card's room is visible in the sidebar.

---

## Where layout state should live — needs one decision

The Team map keeps positions in **localStorage** keyed by environment id
(`omb-team-canvas:<id>`), so layout is per-browser. Column names and sizes are
different in kind: a **name** is content (everyone should see "Blocked" renamed),
while a **size** is arguably preference.

Recommendation:
- **Names → server**, on the board record alongside the cards, so a rename is shared and
  survives a cache clear.
- **Sizes/positions → localStorage first** (matching the Team map, no migration), with a
  note that moving them server-side later is a small change.

This is the one thing worth confirming before the canvas work starts.