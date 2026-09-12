# Hermes gateway API — integration protocol (M0 findings)

Validated live on 2026-09-12 against Hermes Agent v0.21.1
(`hermes gateway run`, port 8642). This is the transport the OpenMausBot
`hermesServe` driver speaks. Everything is plain HTTP + SSE, so the driver
is a pure client: it never spawns Hermes, never touches local Hermes paths,
and works identically against `http://127.0.0.1:8642` today or a VPS
gateway tomorrow — only `baseUrl` changes.

## Running the server (owner-side, not driver-side)

```
API_SERVER_KEY=<secret> hermes gateway run        # default port 8642
GATEWAY_MULTIPLEX_PROFILES=1 ...                  # enable /p/<profile>/ routing
```

- Auth: `Authorization: Bearer <API_SERVER_KEY>` on every route.
- Per-profile keys are **profile-scoped**: a secondary profile served under
  `/p/<name>/` reads its key from that profile's own `.env`
  (`profiles/<name>/.env`), not the process env. Default profile uses the
  process env key.
- `GET /health` → `{"status":"ok","platform":"hermes-agent","version":…}`
  (no auth) — liveness probe for the driver.

## Sessions (the driver's conversation model)

- `POST /api/sessions` `{id?, title?, source?, system_prompt?}` → creates a
  session row. IDs are caller-choosable (validated: no control chars, length
  cap). Driver can use stable ids like `omb_<botId>_<threadId>`.
- `GET /api/sessions` → list with counters (message_count, tokens, cost).
- `GET /api/sessions/{id}` / `PATCH` / `DELETE` — manage.
- `GET /api/sessions/{id}/messages` — history read.
- `POST /api/sessions/{id}/fork` — branch a session.
- `POST /api/sessions/{id}/model` — lock model per session.
- Sessions persist in Hermes `state.db` (SQLite + FTS5) — memory across
  restarts of BOTH apps; Hermes-side `session_search` can recall them.

## Turns (chat)

- `POST /api/sessions/{id}/chat` — non-streaming completion.
  Body: `{message, provider?, model?, …}`. Explicit `provider`+`model`
  override the profile's global routing (validated live:
  `route_source: "raw_request"`).
- `POST /api/sessions/{id}/chat/stream` — **SSE** stream. Event framing
  observed live (each frame: `event: <name>` + `data: {json}`):
  1. `run.started` — `{user_message, runtime, session_id, run_id, seq, ts}`
  2. `message.started` — `{message: {id, role: "assistant"}, run_id, …}`
  3. `assistant.completed` — `{message_id, content, completed, partial,
     interrupted, runtime, usage}` (full text; deltas ride `message.delta`
     events when streaming tokens)
  4. `run.completed` — `{message_id, messages, usage, runtime, run_id}`
  5. `done` — end-of-stream marker
  - Every frame carries `session_id`, `run_id`, monotonic `seq`, `ts` —
    exactly what RuntimeEvent's `turnId`/`itemId` need.
- OpenAI-compatible surface also exists (`/v1/chat/completions`,
  `/v1/responses`) for token-level streaming — the session routes above are
  richer (usage, runtime, run lifecycle).

## Live-run control (interrupt / steer / approvals)

- `POST /v1/runs` → start a run; `GET /v1/runs/{run_id}` → status;
  `GET /v1/runs/{run_id}/events` → event stream (poll/SSE).
- `POST /v1/runs/{run_id}/stop` → interrupt (maps to interruptTurn).
- `POST /v1/runs/{run_id}/steer` `{text}` → mid-turn steering (maps to steer).
- `POST /v1/runs/{run_id}/approval` → answer a pending approval.
  Approval event choices observed in source: `["once","session","always",
  "deny"]` (perm-dependent) — maps to request.opened/respondToRequest.

## Profiles (per-bot memory isolation)

- URL prefix `/p/<profile>/…` routes to that profile's home (own MEMORY.md,
  USER.md, skills, state.db) when the gateway runs with
  `GATEWAY_MULTIPLEX_PROFILES=1`. One gateway process serves every profile.
- A missing/unknown profile → 404 `{"error":"Unknown or unconfigured
  profile"}` (fail closed).
- Same pattern the official Hermes desktop uses (`serve --profile <name>`);
  over the network it is just a URL prefix — the bot's profile travels in
  the engine config, not the process.

## Catalog / skills

- `GET /v1/models` → OpenAI-style model list.
- `GET /api/model/options` → full provider registry with auth status.
- `GET /v1/skills`, `GET /v1/toolsets` → skill/tool listings per profile.

## Group rooms

- RoomLink hosted rooms: `/v1/room-members/{capabilities,grants/refresh,
  grants/revoke,invitations}` — cross-gateway room sessions (source
  `bot_room`, hidden sessions in state.db). Not yet live-validated locally;
  M3 starts with the OMB-native room + per-profile members, and upgrades to
  hosted rooms only if the room API proves workable locally.

## Verified live end-to-end (2026-09-12)

1. health + bearer auth ✔
2. session create/list ✔ (`omb-m0-test-1`)
3. streaming turn: full SSE event sequence ✔ (provider mirror was down;
   succeeded with explicit `provider: opencode-free, model:
   muse-spark-1.3-contributor-free` — routing override works)
4. session memory: second turn quoted the first turn's content ✔
5. profile prefix + scoped keys: routed via `/p/index-black/…` once the
   profile's `.env` carried its own `API_SERVER_KEY` ✔

## Driver mapping (ProviderAdapter → this API)

| OpenMausBot | Hermes gateway |
|---|---|
| `sendTurn` | `POST /api/sessions/{id}/chat/stream` (+create session on first turn) |
| `session.started{sessionId}` | run.started.session_id (cursor = session id; stable ids let us recreate) |
| `content.delta` | message deltas in the SSE stream |
| `turn.completed{usage}` | run.completed |
| `interruptTurn` | `POST /v1/runs/{run_id}/stop` |
| `steer` | `POST /v1/runs/{run_id}/steer` |
| `request.opened` / `respondToRequest` | approval event → `POST /v1/runs/{run_id}/approval` |
| engine config | `{baseUrl, apiKey, profile?}` — no local coupling |
