// Live e2e for the hermes-serve driver against a real gateway (not mocks).
// Run: node scripts/hermes-serve-e2e.mjs (gateway must be running on :8642).
import { HermesServeDriver } from "../server/drivers/hermes-serve.ts";

const config = HermesServeDriver.decodeConfig({
  url: "http://127.0.0.1:8642",
  key: "omb-integration-test-key",
  model: "muse-spark-1.3-contributor-free",
  provider: "opencode-free",
});

const instance = await HermesServeDriver.create({
  instanceId: "e2e",
  displayName: "E2E",
  environment: {},
  enabled: true,
  config,
});

const snapshot = await instance.snapshot();
console.log("snapshot:", snapshot.state, snapshot.authenticated ? "(authed)" : `(${snapshot.reason})`);
if (snapshot.state !== "available") process.exit(1);

const events = [];
instance.adapter.onEvent((e) => events.push(e));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Turn 1: seed a fact.
const t1 = await instance.adapter.sendTurn({
  threadId: "e2e-thread",
  botId: "e2e-bot",
  text: "Remember this code word: GLM-HERMES-LINK. Reply with exactly: SEALED.",
  model: config.model,
});
console.log("turn1 started:", t1.turnId);
let done1;
for (let i = 0; i < 120; i++) {
  await wait(500);
  done1 = events.findLast((e) => e.type === "turn.completed");
  if (done1) break;
}
console.log("turn1 completed:", JSON.stringify({ ok: done1?.ok, usage: done1?.usage }));
const started1 = events.find((e) => e.type === "session.started");
const sessionId = started1?.sessionId;
console.log("session id:", sessionId);
const text1 = events.findLast((e) => e.type === "item.completed" && e.itemType === "assistant_text")?.text;
console.log("turn1 reply:", JSON.stringify(text1));

// Turn 2: resume the session and ask for the fact — proves memory.
events.length = 0;
await instance.adapter.sendTurn({
  threadId: "e2e-thread",
  botId: "e2e-bot",
  text: "What was the code word I asked you to remember? Reply with only the code word.",
  resumeCursor: sessionId,
  model: config.model,
});
let done2;
for (let i = 0; i < 120; i++) {
  await wait(500);
  done2 = events.findLast((e) => e.type === "turn.completed");
  if (done2) break;
}
const text2 = events.findLast((e) => e.type === "item.completed" && e.itemType === "assistant_text")?.text;
console.log("turn2 reply (must contain GLM-HERMES-LINK):", JSON.stringify(text2));
console.log(text2?.includes("GLM-HERMES-LINK") ? "E2E PASS: session memory works" : "E2E FAIL: memory lost");

await instance.dispose();
process.exit(text2?.includes("GLM-HERMES-LINK") ? 0 : 1);
