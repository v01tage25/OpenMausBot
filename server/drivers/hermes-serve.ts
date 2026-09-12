// Hermes gateway driver — the elastic network client for a running
// `hermes gateway` (validated protocol: docs/hermes-serve-protocol.md).
//
// The driver is deliberately a PURE HTTP client: it never spawns Hermes,
// never reads Hermes paths, and never assumes a host. The instance config
// carries {url, key, profile} so the same engine points at a loopback
// gateway today and a VPS gateway tomorrow by editing one field.
//
// Per-bot memory isolation rides the gateway's /p/<profile>/ URL prefix
// (each profile is a full Hermes home: MEMORY.md, USER.md, skills,
// learning loop) — the same pattern the official Hermes desktop uses.
//
// Turn transport is the session-chat SSE stream, whose live event
// vocabulary was validated against Hermes v0.21.1:
//   run.started → message.started → assistant.delta* → tool.started/
//   progress/completed|failed → assistant.completed → run.completed → done
import type {
  DriverCreateInput,
  DriverKind,
  EffortLevel,
  InstanceId,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RequestOutcome,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ThreadId,
  TurnId,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "hermesServe";

const DEFAULT_MODELS: ModelCatalog = {
  default: "hermes-agent",
  options: [{ id: "hermes-agent", label: "Hermes Agent (profile default)" }],
};

/** Per-thread live turn bookkeeping. runId is what the gateway's
 * /v1/runs/{id}/stop|steer routes accept (mirrored from the SSE stream). */
interface LiveTurn {
  turnId: TurnId;
  sessionId: string;
  runId: string | null;
  abort: AbortController;
}

export interface HermesServeConfig {
  /** Gateway base URL (no trailing slash, no path). */
  url: string;
  /** Env var the API server key can come from; config key wins. */
  apiKeyEnv: string;
  key?: string;
  /** Optional Hermes profile: routes every request through /p/<profile>/,
   * isolating this instance's memory/skills/learning. */
  profile?: string;
  /** Optional default model override (e.g. "muse-spark-1.3-contributor-free"). */
  model?: string;
  /** Optional default provider override (e.g. "opencode-free"). */
  provider?: string;
}

const DEFAULT_URL = "http://127.0.0.1:8642";

function decodeConfig(raw: unknown): HermesServeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const urlRaw = typeof o.url === "string" && o.url ? o.url : process.env.HERMES_URL || DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    throw new Error(`Hermes gateway URL is not a valid absolute URL: ${urlRaw}`);
  }
  // http/https only — the driver must never be pointed at file:, data:, etc.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Hermes gateway URL must be http(s): ${urlRaw}`);
  }
  return {
    url: urlRaw.replace(/\/+$/, ""),
    apiKeyEnv: typeof o.apiKeyEnv === "string" && o.apiKeyEnv ? o.apiKeyEnv : "HERMES_API_SERVER_KEY",
    key: typeof o.key === "string" && o.key ? o.key : undefined,
    profile: typeof o.profile === "string" ? o.profile.trim() || undefined : undefined,
    model: typeof o.model === "string" && o.model ? o.model : undefined,
    provider: typeof o.provider === "string" && o.provider ? o.provider : undefined,
  };
}

/** A session id the gateway accepts: ASCII, no control chars, bounded. */
function sessionCandidateId(threadId: ThreadId): string {
  const slug = threadId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return `omb-${slug || "thread"}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/** Parse standard SSE framing: `event:`/`data:` lines accumulate until a
 * blank line dispatches the frame; keepalive comments are skipped. */
class SseParser {
  private buffer = "";
  private event = "";
  private data = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const raw = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw || raw.startsWith(":")) {
        if (!raw) this.dispatch(frames);
        continue;
      }
      if (raw.startsWith("event:")) this.event = raw.slice(6).trim();
      else if (raw.startsWith("data:")) this.data += raw.slice(5).trim();
    }
    return frames;
  }

  private dispatch(frames: SseFrame[]) {
    if (!this.data) {
      this.event = "";
      this.data = "";
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(this.data) as Record<string, unknown>;
    } catch {
      parsed = { raw: this.data };
    }
    frames.push({ event: this.event, data: parsed });
    this.event = "";
    this.data = "";
  }
}

export const HermesServeDriver: ProviderDriver<HermesServeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes Agent (gateway)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<HermesServeConfig>): Promise<ProviderInstance> {
    const { instanceId, displayName, config, environment } = input;
    const apiKey = config.key ?? environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const profilePrefix = config.profile ? `/p/${encodeURIComponent(config.profile)}` : "";
    const base = `${config.url}${profilePrefix}`;

    const listeners = new Set<RuntimeEventListener>();
    const live = new Map<ThreadId, LiveTurn>();
    let disposed = false;

    const emit = (event: RuntimeEvent) => {
      for (const listener of Array.from(listeners)) listener(event);
    };
    const eventBase = (threadId: ThreadId, turnId: TurnId) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND as DriverKind,
      providerInstanceId: instanceId as InstanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const api = async (path: string, init: RequestInit & { timeoutMs?: number } = {}) => {
      const { timeoutMs = 30_000, ...rest } = init;
      const res = await fetch(`${base}${path}`, {
        ...rest,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...rest.headers,
        },
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        throw new Error(`Hermes gateway HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
      }
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    };

    const health = async (): Promise<boolean> => {
      try {
        const res = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(5_000) });
        return res.ok;
      } catch {
        return false;
      }
    };

    const turnMessage = (turn: SendTurnInput): string => {
      // Persona rides session creation's system_prompt; a recovered thread
      // (the gateway lost the session) replays context inline, once.
      if (turn.resumeCursor && turn.recoveryText) {
        return `${turn.text}\n\n[Earlier conversation the session lost]\n${turn.recoveryText}`;
      }
      return turn.text;
    };

    const openSession = async (turn: SendTurnInput): Promise<string> => {
      const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      if (cursor) {
        // Trust the cursor; a dead session surfaces on the chat 404 path.
        return cursor;
      }
      const body: Record<string, unknown> = {
        id: sessionCandidateId(turn.threadId),
        title: displayName ? `${displayName} (OpenMausBot)` : "OpenMausBot thread",
        source: "api_server",
      };
      if (turn.system) body.system_prompt = turn.system;
      const created = await api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
      const session = (created.session ?? created) as Record<string, unknown>;
      const requestedId = body.id as string;
      const id = typeof session.id === "string" ? session.id : requestedId;
      appendNative(`hermes:${instanceId}`, { dir: "out", source: "hermes-serve", msg: { createSession: requestedId } });
      appendNative(`hermes:${instanceId}`, { dir: "in", source: "hermes-serve", msg: created });
      return id;
    };

    const sendTurn = async (turn: SendTurnInput): Promise<{ turnId: TurnId }> => {
      if (disposed) throw new Error("Hermes gateway instance is disposed");
      const turnId = newId();
      const abort = new AbortController();
      const sessionId = await openSession(turn);
      live.set(turn.threadId, { turnId, sessionId, runId: null, abort });

      const body: Record<string, unknown> = { message: turnMessage(turn) };
      if (turn.model) body.model = turn.model;
      else if (config.model) body.model = config.model;
      if (config.provider) body.provider = config.provider;

      // The stream runs to completion inside sendTurn; the harness reads
      // progress through events, matching the boxagent/claude flow.
      void streamTurn(turn, turnId, sessionId, body, abort.signal).finally(() => {
        const current = live.get(turn.threadId);
        if (current?.turnId === turnId) live.delete(turn.threadId);
      });
      return { turnId };
    };

    const streamTurn = async (
      turn: SendTurnInput,
      turnId: TurnId,
      sessionId: string,
      body: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      let runId: string | null = null;
      let reportedSession = sessionId;
      try {
        const res = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (res.status === 404) {
          // The gateway lost this session (fresh state.db). Recreate and
          // replay once via recoveryText so the thread is not blank.
          const fresh = await api("/api/sessions", {
            method: "POST",
            body: JSON.stringify({ id: sessionCandidateId(turn.threadId), source: "api_server" }),
          });
          const session = (fresh.session ?? fresh) as Record<string, unknown>;
          const freshId = typeof session.id === "string" ? session.id : "";
          const entry = live.get(turn.threadId);
          if (entry) entry.sessionId = freshId;
          emit({ ...eventBase(turn.threadId, turnId), type: "runtime.error",
            message: "Hermes session was lost; created a new session (context replayed if available)" });
          emit({ ...eventBase(turn.threadId, turnId), type: "session.started", sessionId: freshId, model: null });
          if (!turn.resumeCursor) {
            emit({ ...eventBase(turn.threadId, turnId), type: "turn.completed", ok: false,
              stopReason: "session-reset", cost: null });
            return;
          }
          return;
        }
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(`Hermes gateway HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
        }

        emit({ ...eventBase(turn.threadId, turnId), type: "turn.started" });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        let completed = false;
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            const d = frame.data;
            const entry = live.get(turn.threadId);
            switch (frame.event) {
              case "run.started": {
                runId = typeof d.run_id === "string" ? d.run_id : null;
                if (entry) entry.runId = runId;
                reportedSession = typeof d.session_id === "string" ? d.session_id : reportedSession;
                if (typeof d.session_id === "string" && d.session_id !== sessionId) {
                  const effective = d.session_id as string;
                  if (entry) entry.sessionId = effective;
                  emit({ ...eventBase(turn.threadId, turnId), type: "session.started",
                    sessionId: effective, model: runtimeModel(d) });
                } else {
                  emit({ ...eventBase(turn.threadId, turnId), type: "session.started",
                    sessionId: reportedSession, model: runtimeModel(d) });
                }
                break;
              }
              case "assistant.delta": {
                const delta = typeof d.delta === "string" ? d.delta : "";
                if (delta) {
                  emit({ ...eventBase(turn.threadId, turnId), type: "content.delta",
                    streamKind: "assistant_text", delta });
                }
                break;
              }
              case "tool.progress": {
                const delta = typeof d.delta === "string" ? d.delta : "";
                const toolName = typeof d.tool_name === "string" ? d.tool_name : "";
                if (delta && (toolName === "_thinking" || toolName === "reasoning")) {
                  emit({ ...eventBase(turn.threadId, turnId), type: "content.delta",
                    streamKind: "reasoning_text", delta });
                }
                break;
              }
              case "tool.started": {
                emit({ ...eventBase(turn.threadId, turnId), type: "item.started", itemType: "tool",
                  title: typeof d.tool_name === "string" ? d.tool_name : undefined,
                  summary: oneLinePreview(d.preview) });
                break;
              }
              case "tool.completed": {
                emit({ ...eventBase(turn.threadId, turnId), type: "item.completed", itemType: "tool", ok: true });
                break;
              }
              case "tool.failed": {
                emit({ ...eventBase(turn.threadId, turnId), type: "item.completed", itemType: "tool", ok: false });
                break;
              }
              case "assistant.completed": {
                const content = typeof d.content === "string" ? d.content : "";
                emit({ ...eventBase(turn.threadId, turnId), type: "item.completed",
                  itemType: "assistant_text", text: content });
                completed = content.length > 0;
                break;
              }
              case "run.completed": {
                const usage = usageOf(d.usage);
                emit({ ...eventBase(turn.threadId, turnId), type: "turn.completed", ok: true,
                  stopReason: null, cost: null, usage });
                break readLoop;
              }
              case "run.failed":
              case "error":
              case "session.error": {
                const message = typeof d.error === "string" ? d.error
                  : typeof d.message === "string" ? d.message : JSON.stringify(d).slice(0, 300);
                emit({ ...eventBase(turn.threadId, turnId), type: "runtime.error", message });
                emit({ ...eventBase(turn.threadId, turnId), type: "turn.completed", ok: false,
                  stopReason: "error", cost: null });
                break readLoop;
              }
              case "done":
                break readLoop;
              default:
                break;
            }
          }
        }
        if (!completed) {
          // Stream ended without run.completed (keepalive cut, disconnect).
          emit({ ...eventBase(turn.threadId, turnId), type: "turn.completed", ok: false,
            stopReason: "stream-ended", cost: null });
        }
        appendNative(`hermes:${instanceId}`, { dir: "out", source: "hermes-serve", msg: body });
        appendNative(`hermes:${instanceId}`, { dir: "in", source: "hermes-serve", msg: { session_id: reportedSession, run_id: runId } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted = signal.aborted;
        emit({ ...eventBase(turn.threadId, turnId), type: "runtime.error", message });
        emit({ ...eventBase(turn.threadId, turnId), type: "turn.completed", ok: false,
          stopReason: aborted ? "interrupted" : "error", cost: null });
      }
    };

    const adapter = {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "in-session" as const,
        queueing: true,
      },
      sendTurn,
      interruptTurn: async (threadId: ThreadId) => {
        const entry = live.get(threadId);
        if (!entry) return;
        entry.abort.abort();
        if (entry.runId) {
          await api(`/v1/runs/${encodeURIComponent(entry.runId)}/stop`, { method: "POST", body: "{}" })
            .catch(() => undefined);
        }
      },
      respondToRequest: async (): Promise<RequestOutcome> => {
        // v1: the session-chat stream carries no approval events — Hermes'
        // own approval policy governs the turn (yolo/ask on the gateway
        // side). Fail closed rather than pretending an answer landed.
        return "unavailable";
      },
      steer: async (threadId: ThreadId, text: string) => {
        const entry = live.get(threadId);
        if (!entry?.runId) return false;
        try {
          await api(`/v1/runs/${encodeURIComponent(entry.runId)}/steer`, {
            method: "POST",
            body: JSON.stringify({ text }),
          });
          return true;
        } catch {
          return false;
        }
      },
      hasSession: (threadId: ThreadId) => live.has(threadId),
      stopAll: async () => {
        for (const entry of Array.from(live.values())) {
          entry.abort.abort();
          if (entry.runId) {
            await api(`/v1/runs/${encodeURIComponent(entry.runId)}/stop`, { method: "POST", body: "{}" })
              .catch(() => undefined);
          }
        }
        live.clear();
      },
      onEvent(listener: RuntimeEventListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!(await health())) {
        return {
          state: "unavailable",
          reason: `No Hermes gateway at ${config.url} (run: hermes gateway run, then set the URL/key)`,
        };
      }
      try {
        await api("/v1/models");
        return { state: "available", authenticated: true, billing: "metered" };
      } catch {
        return { state: "unavailable", reason: `Gateway at ${config.url} rejected the API key`, authenticated: false };
      }
    };

    const refreshModels = async () => {
      try {
        const listed = await api("/v1/models");
        const data = Array.isArray(listed.data) ? listed.data : [];
        const options = data
          .map((m) => (typeof (m as Record<string, unknown>)?.id === "string" ? (m as Record<string, unknown>).id as string : null))
          .filter((id): id is string => Boolean(id))
          .slice(0, 50)
          .map((id) => ({ id, label: id, custom: true }));
        if (options.length > 0) modelsCatalog.options = options;
      } catch {
        // A catalog refresh is advisory; the static default stays.
      }
    };

    const modelsCatalog: ModelCatalog = { ...DEFAULT_MODELS, options: [...DEFAULT_MODELS.options] };
    if (config.model) {
      modelsCatalog.default = config.model;
      if (!modelsCatalog.options.some((o) => o.id === config.model)) {
        modelsCatalog.options.unshift({ id: config.model, label: `${config.model} (configured)`, custom: true });
      }
    }

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      enabled: input.enabled,
      models: modelsCatalog,
      refreshModels,
      adapter,
      snapshot,
      async generateText(prompt: string): Promise<string> {
        const res = await api("/v1/chat/completions", {
          method: "POST",
          timeoutMs: 120_000,
          body: JSON.stringify({ model: config.model ?? "hermes-agent", messages: [{ role: "user", content: prompt }] }),
        });
        const choices = Array.isArray(res.choices) ? res.choices : [];
        const message = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
        return typeof message?.content === "string" ? message.content : "";
      },
      async dispose() {
        disposed = true;
        await adapter.stopAll();
      },
    };
  },
};

function runtimeModel(payload: Record<string, unknown>): string | null {
  const runtime = payload.runtime as Record<string, unknown> | undefined;
  return typeof runtime?.model === "string" ? runtime.model : null;
}

function usageOf(usage: unknown): { input: number; output: number } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.prompt_tokens);
  const output = Number(u.output_tokens ?? u.completion_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 };
}

function oneLinePreview(preview: unknown): string | undefined {
  if (typeof preview !== "string" || !preview) return undefined;
  const line = preview.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
  return line.slice(0, 200) || undefined;
}

export const HERMES_SERVE_DRIVER_KIND: DriverKind = DRIVER_KIND;
export type { EffortLevel };
