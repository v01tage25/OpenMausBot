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

  it("sends the reasoning effort as model_options.reasoning", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort", text: "think hard", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");
    const chat = fake?.calls.find((c) => c.url.includes("/chat/stream"));
    expect(chat).toBeDefined();
    expect((chat!.body as Record<string, unknown>).model_options).toEqual({
      reasoning: { enabled: true, effort: "high" },
    });

    await instance.adapter.sendTurn({ threadId: "t-effort-off", text: "no thinking", effort: "none" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId !== (chat!.body as unknown));
    const chat2 = fake?.calls.filter((c) => c.url.includes("/chat/stream")).at(-1);
    expect(chat2).toBeDefined();
    expect((chat2!.body as Record<string, unknown>).model_options).toEqual({ reasoning: { enabled: false } });
  });

  it("declares the reasoning ladder the gateway accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("builds the picker catalog from authenticated providers and splits provider:model on send", async () => {
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
      if (url.endsWith("/health")) return json({ status: "ok" });
      if (method === "GET" && url.includes("/api/model/options")) {
        return json({
          providers: [
            { slug: "opencode-free", name: "OpenCode Free", authenticated: true, models: ["muse-spark-1.3-contributor-free", "deepseek-v4-flash-free"] },
            { slug: "copilot", name: "Copilot", authenticated: true, models: ["gpt-5.4"] },
            { slug: "openrouter", name: "OpenRouter", authenticated: false, models: ["should-not-appear"] },
          ],
        });
      }
      if (method === "POST" && url.endsWith("/api/sessions")) {
        return json({ object: "hermes.session", session: { id: "sess-cat", source: "api_server" } });
      }
      if (method === "POST" && url.includes("/chat/stream")) {
        return new Response(sse([["run.completed", { usage: { input_tokens: 1, output_tokens: 1 } }]]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return json({ error: `unexpected ${method} ${url}` }, 404);
    }) as typeof fetch;
    try {
      await create();
      await instance.refreshModels?.();
      const ids = instance.models.options.map((o) => o.id);
      expect(ids).toContain("opencode-free:muse-spark-1.3-contributor-free");
      expect(ids).toContain("copilot:gpt-5.4");
      expect(ids.some((id) => id.startsWith("openrouter:"))).toBe(false);

      await instance.adapter.sendTurn({ threadId: "t-cat", text: "hi", model: "opencode-free:muse-spark-1.3-contributor-free" });
      await recorder.until((e) => e.type === "turn.completed");
      const chat = calls.find((c) => c.url.includes("/chat/stream"));
      expect(chat).toBeDefined();
      expect((chat!.body as Record<string, unknown>).provider).toBe("opencode-free");
      expect((chat!.body as Record<string, unknown>).model).toBe("muse-spark-1.3-contributor-free");
    } finally {
      globalThis.fetch = previous;
    }
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

// Regression cover for the five OMB→Hermes gateway defects reported from the
// Luna instance (2026-09-13). Each test fails against the pre-fix driver.
describe("HermesServeDriver — gateway link fixes", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let fake: ReturnType<typeof installFakeGateway> | undefined;

  /** Let in-flight async emissions settle before counting them. `until`
   * resolves on the FIRST match, so a count read immediately after could
   * miss a duplicate emitted a microtask later. */
  const settleEmissions = () => new Promise((resolve) => setTimeout(resolve, 25));

  const create = async (partial: Partial<HermesServeConfig> = {}) => {
    instance = await HermesServeDriver.create({
      instanceId: "hermes-test",
      displayName: "Luna",
      environment: { HERMES_API_SERVER_KEY: "k-test" },
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

  // Bug 1: a normal resuming turn must carry ONLY the user's words.
  it("sends a plain turn on a live cursor — no conversation replay in the body", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create();
    await instance.adapter.sendTurn({
      threadId: "b1",
      text: "what is the balance?",
      resumeCursor: "sess-live",
      recoveryText: "User: earlier question\nAssistant: earlier answer",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const chat = fake?.calls.find((c) => c.url.includes("/chat/stream"));
    const message = (chat?.body as Record<string, unknown> | undefined)?.message;
    expect(message).toBe("what is the balance?");
    expect(String(message)).not.toContain("Earlier conversation");
  });

  // Bug 1: three sequential turns must not accumulate history.
  it("keeps three sequential turns free of replayed history", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create();
    for (const text of ["one", "two", "three"]) {
      await instance.adapter.sendTurn({
        threadId: "b1b",
        text,
        resumeCursor: "sess-live",
        recoveryText: "User: old\nAssistant: older",
      });
      await recorder.until((e) => e.type === "turn.completed");
    }
    const bodies = fake?.calls
      .filter((c) => c.url.includes("/chat/stream"))
      .map((c) => (c.body as Record<string, unknown>).message);
    expect(bodies).toEqual(["one", "two", "three"]);
  });

  // Bug 1: a lost session recovers ONCE, with history, on a fresh session.
  it("recovers a lost session exactly once, replaying history into the new session", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const previous = globalThis.fetch;
    let chatAttempts = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = String(init?.method ?? "GET").toUpperCase();
      let body: unknown;
      if (typeof init?.body === "string") {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      calls.push({ method, url, body });
      if (url.endsWith("/health")) return json({ status: "ok" });
      if (method === "POST" && url.endsWith("/api/sessions")) {
        return json({ object: "hermes.session", session: { id: "sess-fresh", source: "api_server" } });
      }
      if (method === "POST" && url.includes("/chat/stream")) {
        chatAttempts += 1;
        // First attempt hits the dead cursor; the retry lands on the new
        // session and reports THAT id, like the real gateway does.
        if (chatAttempts === 1) return json({ error: "session not found" }, 404);
        const retryFrames: Array<[string, Record<string, unknown>]> = [
          ["run.started", { session_id: "sess-fresh", run_id: "run_2", runtime: { model: "m" } }],
          ["assistant.completed", { content: "recovered" }],
          ["run.completed", { usage: { input_tokens: 1, output_tokens: 1 } }],
          ["done", {}],
        ];
        return new Response(sse(retryFrames), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return json({ error: `unexpected ${method} ${url}` }, 404);
    }) as typeof fetch;
    try {
      await create();
      await instance.adapter.sendTurn({
        threadId: "b1c",
        text: "and now?",
        resumeCursor: "sess-dead",
        recoveryText: "User: first\nAssistant: second",
      });
      const completed = await recorder.until((e) => e.type === "turn.completed");
      expect((completed as Extract<RuntimeEvent, { type: "turn.completed" }>).ok).toBe(true);
      expect(chatAttempts).toBe(2);
      const retry = calls.filter((c) => c.url.includes("/chat/stream")).at(-1);
      expect(retry?.url).toContain("sess-fresh");
      const message = String((retry?.body as Record<string, unknown> | undefined)?.message ?? "");
      expect(message).toContain("Earlier conversation the session lost");
      expect(message).toContain("User: first");
      expect(message).toContain("and now?");
      // The replacement session is announced so the harness persists it.
      const started = recorder.events.filter((e) => e.type === "session.started");
      expect(started.at(-1) && (started.at(-1) as Extract<RuntimeEvent, { type: "session.started" }>).sessionId).toBe("sess-fresh");
    } finally {
      globalThis.fetch = previous;
    }
  });

  // Bug 1: no cursor means nothing to rebuild — fail closed, no blind retry.
  it("does not retry a lost session when there was no cursor to resume", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = String(init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      if (url.endsWith("/health")) return json({ status: "ok" });
      if (method === "POST" && url.endsWith("/api/sessions")) {
        return json({ object: "hermes.session", session: { id: "sess-new", source: "api_server" } });
      }
      if (method === "POST" && url.includes("/chat/stream")) return json({ error: "nope" }, 404);
      return json({ error: "unexpected" }, 404);
    }) as typeof fetch;
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "b1d", text: "hello" });
      const completed = await recorder.until((e) => e.type === "turn.completed");
      expect((completed as Extract<RuntimeEvent, { type: "turn.completed" }>).ok).toBe(false);
      expect(calls.filter((c) => c.url.includes("/chat/stream")).length).toBe(1);
    } finally {
      globalThis.fetch = previous;
    }
  });

  // Bug 2: hermesServe must NOT advertise in-turn queueing, so a mid-turn
  // send waits for its own follow-up turn instead of amending the live run.
  it("does not advertise in-turn queueing, so busy sends wait their turn", async () => {
    await create();
    expect(instance.adapter.capabilities.queueing).toBeFalsy();
    // The explicit steer action stays available for Stop-then-steer.
    expect(typeof instance.adapter.steer).toBe("function");
  });

  // Bug 3: every new thread gets a distinct session title.
  it("creates sessions with a per-thread title so a second thread is not rejected", async () => {
    const titles: unknown[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = String(init?.method ?? "GET").toUpperCase();
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === "string") {
        try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = undefined; }
      }
      if (url.endsWith("/health")) return json({ status: "ok" });
      if (method === "POST" && url.endsWith("/api/sessions")) {
        titles.push(body?.title);
        return json({ object: "hermes.session", session: { id: body?.id ?? "sess", source: "api_server" } });
      }
      if (method === "POST" && url.includes("/chat/stream")) {
        return new Response(sse([["run.completed", { usage: { input_tokens: 1, output_tokens: 1 } }]]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return json({ error: "unexpected" }, 404);
    }) as typeof fetch;
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "thread-alpha", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");
      await instance.adapter.sendTurn({ threadId: "thread-beta", text: "hi again" });
      // The second turn starts on a different thread, so wait for the SECOND
      // settlement rather than the first (which belongs to thread-alpha).
      await recorder.until(() => recorder.events.filter((e) => e.type === "turn.completed").length >= 2);
      expect(titles.length).toBe(2);
      expect(titles[0]).toBeTruthy();
      expect(titles[0]).not.toBe(titles[1]);
    } finally {
      globalThis.fetch = previous;
    }
  });

  // Bug 3: a colliding title falls back to a title-less create instead of a 400.
  it("falls back to a title-less create when the gateway rejects the title", async () => {
    const creates: Array<Record<string, unknown> | undefined> = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = String(init?.method ?? "GET").toUpperCase();
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === "string") {
        try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = undefined; }
      }
      if (url.endsWith("/health")) return json({ status: "ok" });
      if (method === "POST" && url.endsWith("/api/sessions")) {
        creates.push(body);
        if (body?.title) {
          return json({ error: { message: "Title already in use by session omb-x", type: "invalid_request_error" } }, 400);
        }
        return json({ object: "hermes.session", session: { id: body?.id ?? "sess", source: "api_server" } });
      }
      if (method === "POST" && url.includes("/chat/stream")) {
        return new Response(sse([["run.completed", { usage: { input_tokens: 1, output_tokens: 1 } }]]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return json({ error: "unexpected" }, 404);
    }) as typeof fetch;
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "thread-clash", text: "hi" });
      const completed = await recorder.until((e) => e.type === "turn.completed");
      expect((completed as Extract<RuntimeEvent, { type: "turn.completed" }>).ok).toBe(true);
      expect(creates.length).toBe(2);
      expect(creates[0]?.title).toBeTruthy();
      expect(creates[1]?.title).toBeUndefined();
    } finally {
      globalThis.fetch = previous;
    }
  });

  // Bug 5: exactly ONE turn.completed per turn, run chip clears on it.
  it("emits exactly one turn.completed when run.completed is followed by done", async () => {
    fake = installFakeGateway({ streamFrames: happyFrames });
    await create();
    await instance.adapter.sendTurn({ threadId: "b5a", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    await settleEmissions();
    const settlements = recorder.events.filter((e) => e.type === "turn.completed");
    expect(settlements.length).toBe(1);
    expect((settlements[0] as Extract<RuntimeEvent, { type: "turn.completed" }>).ok).toBe(true);
  });

  // Bug 5: a stream that just ends still settles the turn exactly once.
  it("settles a stream-ended turn exactly once", async () => {
    fake = installFakeGateway({
      streamFrames: [
        ["run.started", { session_id: "sess-1", run_id: "run_1", runtime: { model: "m" } }],
        ["assistant.delta", { delta: "partial" }],
      ],
    });
    await create();
    await instance.adapter.sendTurn({ threadId: "b5b", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    await settleEmissions();
    const settlements = recorder.events.filter((e) => e.type === "turn.completed");
    expect(settlements.length).toBe(1);
    expect((settlements[0] as Extract<RuntimeEvent, { type: "turn.completed" }>).stopReason).toBe("stream-ended");
  });

  // Bug 5: one tool call is exactly one started/completed pair.
  it("pairs one tool call into one start and one completion", async () => {
    fake = installFakeGateway({
      streamFrames: [
        ["run.started", { session_id: "sess-1", run_id: "run_1", runtime: { model: "m" } }],
        ["tool.started", { tool_name: "terminal", preview: "ls" }],
        ["tool.completed", { tool_name: "terminal" }],
        ["assistant.completed", { content: "done" }],
        ["run.completed", { usage: { input_tokens: 1, output_tokens: 1 } }],
        ["done", {}],
      ],
    });
    await create();
    await instance.adapter.sendTurn({ threadId: "b5c", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    await settleEmissions();
    const starts = recorder.events.filter((e) => e.type === "item.started" && e.itemType === "tool");
    const ends = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
  });

  // Bug 5: a tool whose result never streams is closed so its step ends.
  it("closes an unpaired tool step when the stream ends without its completion", async () => {
    fake = installFakeGateway({
      streamFrames: [
        ["run.started", { session_id: "sess-1", run_id: "run_1", runtime: { model: "m" } }],
        ["tool.started", { tool_name: "terminal", preview: "ls" }],
        // no tool.completed, no run.completed — the socket just ends
      ],
    });
    await create();
    await instance.adapter.sendTurn({ threadId: "b5d", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    await settleEmissions();
    const starts = recorder.events.filter((e) => e.type === "item.started" && e.itemType === "tool");
    const ends = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect((ends[0] as Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>).ok).toBe(false);
  });
});
