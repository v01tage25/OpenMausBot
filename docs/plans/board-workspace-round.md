# Board workspace round: markdown briefs, canvas columns, rename, resize

**Status:** built, except the copywriter pass. Kept as the record of what was
decided and why, so the reasoning is not only in commit messages.

Extends `task-board-dates-multibot-todos.md`, which holds the still-unbuilt
dates / multi-bot / checklist work.

---

## Agreed decisions, and what actually shipped

| # | Decision | Outcome |
|---|---|---|
| 1 | **Markdown briefs, not a WYSIWYG editor.** Stored as markdown, rendered with react-markdown + remark-gfm. | **Done**, with its own small component rather than `ChatMarkdown` — the chat one drags in mention linking, thread refs and code chrome a card does not need. The editor shows the syntax and a live preview of what the bot will see. |
| 3 | **Canvas columns**, no overlap. | **Done, but the rule changed twice — see below.** |
| 6 | **Columns resize**, persisted. | **Done.** Width and height, with a corner grip so the gesture is discoverable. |
| 3-ord | Default layout is the board's existing left-to-right order. | **Done.** Nothing moves for an existing viewer. |
| 4 | **Click a column title to rename**, persisted, discoverable. | **Done**, plus a reset to the default name. |
| 5 | **Restyle** toward the Team map. | **Done for columns and cards**: panel surfaces, hairlines, the Team map's neutral hover (not the accent), no focus ring on a held column. |
| 7 | Dead code audited; **re-audit after the round**. | **Done twice.** First pass removed `teamOptions` and `isWorkOrigin`; the post-round pass removed four strings with no readers. |
| 8 | **Copywriter pass on board strings.** | **Not done.** Waiting on approval — the proposal is below. |

Explicitly **not** wanted: rich-text editor (§1), separate todo list (§1 of the other doc).

---

## The overlap rule: two corrections worth remembering

The first design refused a drop that would land on another column. That was
rejected in use — *"give it to him wherever he wants, don't show that you can't
lay it out"* — because refusing fights the person: they aimed somewhere and the
board said no without offering an alternative.

The second design pushed neighbours out of the way **during** the drag. Also
rejected: *"all the same, when dragging, the neighbouring stacks run away
somewhere"*. A column rearranging the board while it is being carried makes
every gesture move several things at once.

**What shipped**, on the third try: a held column moves freely *over* the
others (it lifts, nothing else shifts, nothing is written to storage), and the
board tidies exactly once, on drop. The dropped column keeps the spot it was
released on; anything it covered is re-seated at the nearest free place,
searched in rings so a displaced column stays nearby instead of being flung
across the board.

Two follow-on defects found by looking at the live board, not the tests: a
column could be dragged off-screen (now clamped, keeping enough visible to grab
its header), and the settling pass only checked collisions against the dropped
column, so a board that was *already* overlapping kept its pile. The pass now
repairs the board it was given.

## Where layout state lives — decided

**Names, sizes and positions are all `localStorage`**, keyed by environment id
(`omb-task-board-layout:<envId>`), matching the Team map. The user's call:
personal browser customization, not shared content. Clearing site data costs an
arrangement, not work.

---

## The copywriter proposal (needs approval before it is applied)

The board's strings are already plain and specific, which is good product
writing — the aim here is wording, not marketing gloss. Proposed changes, with
the reasoning:

| Current | Proposed | Why |
|---|---|---|
| "Ready" (To do column) | "To do" | The column is *named* To do in the header but its status chip says "Ready", so one column has two names. |
| "Not started" (Backlog chip) | "Backlog" | Same problem: the header says Backlog, the chip says Not started. |
| "What needs doing?" | "What needs doing?" | Keep — it is good. |
| "Assign a bot to start this card" | "Pick a bot to start this" | Shorter, and "pick" matches the picker that replaced the dropdown. |
| "The bot asked a question — open the chat to answer" | "Waiting on your answer — open the chat" | Leads with the state, not the event. |
| "A board of work, one card at a time. Your bots stay where they are — a card only points at the chat a job runs in." | Keep, maybe split | Accurate and human; only the second sentence is dense. |
| "Columns cannot overlap" | *(removed)* | No longer possible to produce. |

Two things I am **not** proposing to change: "Nothing runs on its own" (it earns
its place by answering the obvious first worry) and any status that names a real
backend state (`auth_required`), since renaming those would hide what happened.

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

## Still to do in this round

1. **Copywriter pass** — the proposal above, waiting on approval.

## Still to build (from the earlier doc, unchanged)

- Card checklist, with all-done → Done and its guardrails.
- `dueAt` (display-only) and `runAt` armed by the To-do column.
- Multi-bot assignment → group chat, including the open question about whether a
  card's room is visible in the sidebar.