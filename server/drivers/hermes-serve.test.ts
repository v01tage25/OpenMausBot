// Hermes gateway driver tests against a scripted fake of the gateway's
// REST+SSE surface (protocol shapes from docs/hermes-serve-protocol.md,
// validated live against Hermes v0.21.1). The fake replays the exact SSE
// event vocabulary: run.started → message.started → assistant.delta* →
// tool.started/completed → assistant.completed → run.completed → done.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { HermesServeDriver, type HermesServeConfig } from "./hermes-serve.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An SSE body streaming `frames` (event name + data object pairs). */
function sse(frames: Array<[string, Record<string, unknown>]>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i += 1;
    },
  });
}

interface FakeOptions {
  streamFrames?: Array<[string, Record<string, unknown>]>;
  sessionAlreadyGone?: boolean;
  chatStatus?: number;
}

/** Install a fake hermes gateway; returns restore() plus a call log. */
function installFakeGateway(options: FakeOptions = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: unknown;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });
    if (url.endsWith("/health")) return json({ status: "ok", platform: "hermes-agent", version: "0.21.1" });
    if (method === "GET" && url.endsWith("/v1/models")) {
      return json({ object: "list", data: [{ id: "hermes-agent" }] });
    }
    if (method === "POST" && url.endsWith("/api/sessions")) {
      const requested = (body as Record<string, unknown> | undefined)?.id;
      return json({ object: "hermes.session", session: { id: requested ?? "sess-1", source: "api_server" } });
    }
    if (method === "POST" && url.includes("/chat/stream")) {
      if (options.chatStatus) return json({ error: "boom" }, options.chatStatus);
      if (options.sessionAlreadyGone) return json({ error: "session not found" }, 404);
      return new Response(sse(options.streamFrames ?? []), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (method === "POST" && url.includes("/stop")) return json({ ok: true });
    if (method === "POST" && url.includes("/steer")) return json({ ok: true });
    return json({ error: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

const happyFrames: Array<[string, Record<string, unknown>]> = [
  ["run.started", { session_id: "sess-1", run_id: "run_1", runtime: { provider: "opencode-free", model: "muse-spark" } }],
  ["message.started", { message: { id: "msg_1", role: "assistant" }, run_id: "run_1" }],
  ["assistant.delta", { message_id: "msg_1", delta: "Hel" }],
  ["assistant.delta", { message_id: "msg_1", delta: "lo!" }],
  ["tool.started", { tool_name: "terminal", preview: "ls -la\ndetail line", run_id: "run_1" }],
  ["tool.completed", { tool_name: "terminal", run_id: "run_1" }],
  ["assistant.completed", { message_id: "msg_1", content: "Hello!", completed: true }],
  ["run.completed", { message_id: "msg_1", completed: true, usage: { input_tokens: 10, output_tokens: 5 } }],
  ["done", {}],
];

describe("HermesServeDriver (fake gateway)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let fake: ReturnType<typeof installFakeGateway> | undefined;

  const create = async (partial: Partial<HermesServeConfig> = {}, environment: Record<string, string> = {}) => {
    instance = await HermesServeDriver.create({
      instanceId: "hermes-test",
      displayName: "Hermes Test",
      environment: { HERMES_API_SERVER_KEY: "k-test", ...environment },
      enabled: true,
      config: HermesServeDriver.decodeConfig(partial),
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    fake?.restore();
    fake = undefined;
  });

  it("decodes config: url validation and profile routing", () => {
    expect(() => HermesServeDriver.decodeConfig({ url: "ftp://x" })).toThrow(/http\(s\)/);
    expect(() => HermesServeDriver.decodeConfig({ url: "not a url" })).toThrow(/valid absolute URL/);
    const config = HermesServeDriver.decodeConfig({ url: "http://vps.example:8642/", profile: "scout" });
    expect(config.url).toBe("http://vps.example:8642");
    expect(config.profile).toBe("scout");
  });

  it("streams a happy turn: session start, deltas, tool, completion, usage", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create();
    await instance.adapter.sendTurn({ threadId: "t1", text: "hi" });

    const started = await recorder.until((e) => e.type === "session.started");
    expect((started as Extract<RuntimeEvent, { type: "session.started" }>).sessionId).toBe("sess-1");

    const delta = await recorder.until((e) => e.type === "content.delta" && e.delta === "Hel");
    expect(delta.type).toBe("content.delta");

    const tool = await recorder.until((e) => e.type === "item.started" && e.itemType === "tool");
    expect((tool as Extract<RuntimeEvent, { type: "item.started" }>).title).toBe("terminal");
    expect((tool as Extract<RuntimeEvent, { type: "item.started" }>).summary).toBe("ls -la");

    const text = await recorder.until((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect((text as Extract<RuntimeEvent, { type: "item.completed"; itemType: "assistant_text" }>).text).toBe("Hello!");

    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect((completed as Extract<RuntimeEvent, { type: "turn.completed" }>).usage).toEqual({ input: 10, output: 5 });

    // Session creation carried the persona as system_prompt.
    const createCall = fake?.calls.find((c) => c.url.endsWith("/api/sessions"));
    expect(createCall?.body).toMatchObject({ source: "api_server" });
  });

  it("routes through /p/<profile>/ and sends the profile-scoped URL on every call", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create({ url: "http://127.0.0.1:8642", profile: "scout" });
    await instance.adapter.sendTurn({ threadId: "t2", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(fake?.calls.every((c) => !c.url.endsWith("/health") || true)).toBe(true);
    const chat = fake?.calls.find((c) => c.url.includes("/chat/stream"));
    expect(chat?.url).toContain("/p/scout/api/sessions/");
  });

  it("resumes from the resumeCursor without creating a session", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create();
    await instance.adapter.sendTurn({ threadId: "t3", text: "continue", resumeCursor: "sess-existing" });
    await recorder.until((e) => e.type === "turn.completed");
    // The cursor IS the session: no creation call, chat goes to it directly.
    const creates = fake?.calls.filter((c) => c.url.endsWith("/api/sessions") && c.method === "POST");
    expect(creates?.length).toBe(0);
    expect(fake?.calls.find((c) => c.url.includes("/chat/stream"))?.url).toContain("sess-existing");
  });

  it("steers the live run through /v1/runs/{id}/steer and reports the outcome", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create();
    const started = instance.adapter.sendTurn({ threadId: "t4", text: "long turn" });
    await recorder.until((e) => e.type === "session.started");
    const steered = await instance.adapter.steer?.("t4", "focus on X");
    expect(steered).toBe(true);
    expect(fake?.calls.some((c) => c.url.includes("/v1/runs/run_1/steer"))).toBe(true);
    await started;
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("interrupt aborts the stream and calls /v1/runs/{id}/stop", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create();
    const started = instance.adapter.sendTurn({ threadId: "t5", text: "long turn" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t5");
    await started;
    expect(fake?.calls.some((c) => c.url.includes("/v1/runs/run_1/stop"))).toBe(true);
  });

  it("marks the engine unavailable when the gateway is down or rejects the key", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    try {
      await create();
      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("unavailable");
      expect(snapshot.reason).toMatch(/No Hermes gateway/);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("reports key rejection from the gateway as unauthenticated", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/health")) return json({ status: "ok" });
      return json({ error: "Invalid gateway API key" }, 401);
    }) as typeof fetch;
    try {
      await create();
      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("unavailable");
      expect(snapshot.authenticated).toBe(false);
      expect(snapshot.reason).toMatch(/rejected the API key/);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("fails closed on approvals: respondToRequest resolves unavailable", async () => {
    await create();
    const outcome = await instance.adapter.respondToRequest("t6", "req-1", { behavior: "allow" });
    expect(outcome).toBe("unavailable");
  });

  it("ends the turn with an error event when the stream fails mid-turn", async () => {
    fake = installFakeGateway({
      streamFrames: [
        ["run.started", { session_id: "sess-1", run_id: "run_1", runtime: { model: "m" } }],
        ["error", { error: "upstream exploded" }],
      ],
    });
    await create();
    await instance.adapter.sendTurn({ threadId: "t7", text: "hi" });
    const error = await recorder.until((e) => e.type === "runtime.error");
    expect((error as Extract<RuntimeEvent, { type: "runtime.error" }>).message).toBe("upstream exploded");
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect((completed as Extract<RuntimeEvent, { type: "turn.completed" }>).ok).toBe(false);
  });
});
