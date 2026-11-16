import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type TestGateway } from "./harness.js";
import { peerBindings, peerFrame, preparePeerBinding } from "../../src/claude/nativePeer.js";
import { testConfig } from "../fixtures/config.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({ ...await original<object>(), query: fakeQuery, startup: fakeStartup }));
const originalEnv = { ...process.env };
const roots: string[] = [];
let gateway: TestGateway | undefined;
afterEach(async () => { await gateway?.stop(); gateway = undefined; process.env = { ...originalEnv }; for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const text = (value: string) => [{ type: "text", text: value, text_elements: [] }];

async function fixture() {
  fakeClaude.reset();
  const root = mkdtempSync("/tmp/ccx-peer-test-"); roots.push(root);
  const home = join(root, "claude"), product = join(root, "product"), state = join(root, "jobs"), sid = randomUUID();
  const dir = join(home, "projects", "-work");mkdirSync(dir, { recursive: true });mkdirSync(join(home, "sessions"));mkdirSync(product);
  const transcript = join(dir, sid + ".jsonl"), at = new Date().toISOString();
  writeFileSync(transcript, [
    { type: "user", uuid: "initial-user", parentUuid: null, sessionId: sid, timestamp: at, cwd: "/work", message: { role: "user", content: "seed" } },
    { type: "assistant", uuid: "initial-agent", parentUuid: "initial-user", sessionId: sid, timestamp: at, message: { role: "assistant", model: "claude-opus-5-5", id: "msg_initial", content: [{ type: "text", text: "seed ready" }], stop_reason: "end_turn" } },
  ].map((v) => JSON.stringify(v)).join("\n") + "\n");
  writeFileSync(join(home, "sessions", process.pid + ".json"), JSON.stringify({ pid: process.pid, sessionId: sid, version: "2.1.325" }));
  writeFileSync(join(product, "native-peer-bridge.json"), JSON.stringify({ enabled: true, python: process.execPath, script: resolve("tests/fixtures/fakePeerBridge.mjs"), stateDir: state }));
  process.env.CLAUDE_CONFIG_DIR = home;process.env.CODEX_HOME = join(root, "codex");process.env.FAKE_PEER_OWNER_PID = String(process.pid);process.env.FAKE_PEER_TRANSCRIPT = transcript;process.env.FAKE_PEER_SENDS = join(root, "sends.jsonl");
  gateway = await startTestGateway({ claudeHome: home, productHome: product, dataDir: join(root, "data"), claudeVisualize: false });
  const client = await gateway.connect();
  await client.request("thread/resume", { threadId: sid, excludeTurns: true });
  return { root, sid, client, transcript, state };
}

describe("shared native App writer", () => {
  it("uses the existing owner only, returns native reply, and keeps refresh/paging IDs stable", async () => {
    const { root, sid, client } = await fixture();const clientId = randomUUID(), before = fakeClaude.prompts.length;
    const result = await client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("hello shared") });
    const done = await client.waitFor("turn/completed", (p) => p.threadId === sid && p.turn.id === result.turn.id, 10000);
    expect(done.turn.status).toBe("completed");expect(fakeClaude.prompts.length).toBe(before);
    const history = (await client.request("thread/read", { threadId: sid, includeTurns: true })).thread;
    const turn = history.turns.find((t: any) => t.id === result.turn.id);
    expect(turn.items.filter((i: any) => i.type === "userMessage")).toMatchObject([{ id: result.turn.id, clientId, content: text("hello shared") }]);
    expect(turn.items.some((i: any) => i.type === "agentMessage" && i.text === "app: hello shared")).toBe(true);
    expect(history.turns.filter((t: any) => t.id === result.turn.id)).toHaveLength(1);
    const items = await client.request("thread/items/list", { threadId: sid, turnId: result.turn.id, limit: 100 });expect(items.data.length).toBeGreaterThan(0);
    const beforeRetry = client.messages.length;
    const retried = await client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("hello shared") });
    await client.waitFor("turn/completed", (p) => p.threadId === sid && p.turn.id === retried.turn.id
      && client.messages.slice(beforeRetry).some((m) => m.method === "turn/completed" && m.params.turn.id === retried.turn.id), 10000);
    expect(readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(fakeClaude.prompts.length).toBe(before);
    rmSync(join(root, "claude", "sessions", process.pid + ".json"));
    const afterOwnerExit = client.messages.length;
    await client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("hello shared") });
    await client.waitFor("turn/completed", (p) => p.threadId === sid
      && client.messages.slice(afterOwnerExit).some((m) => m.method === "turn/completed" && m.params.threadId === sid), 10000);
    expect(fakeClaude.prompts.length).toBe(before);
    expect(readFileSync(join(root, "sends.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 20000);

  it("does not stop/steer the original App and rejects unsupported attachments before sending", async () => {
    const { root, sid, client } = await fixture();
    await expect(client.request("thread/settings/update", { threadId: sid, model: "claude:claude-haiku-4-5-20251001" })).rejects.toThrow("no setting was changed");
    await expect(client.request("thread/revert", { threadId: sid, beforeTurnId: "initial-user" })).rejects.toThrow("no App task or history was changed");
    await expect(client.request("thread/compact/start", { threadId: sid })).rejects.toThrow("no App task or history was changed");
    await expect(client.request("turn/start", { threadId: sid, clientUserMessageId: randomUUID(), input: [{ type: "image", url: "data:image/png;base64,fixture" }] })).rejects.toThrow("text only");
    expect(existsSync(join(root, "sends.jsonl"))).toBe(false);
    const clientId = randomUUID();
    await client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("one") });
    await expect(client.request("turn/start", { threadId: sid, clientUserMessageId: clientId, input: text("different") })).rejects.toThrow("identity conflict");
    await expect(client.request("turn/interrupt", { threadId: sid })).rejects.toThrow("No App task was stopped");
    await expect(client.request("turn/steer", { threadId: sid, input: text("two") })).rejects.toThrow("not interrupted");
    const done = await client.waitFor("turn/completed", (p) => p.threadId === sid, 10000);expect(done.turn.status).toBe("completed");
    expect(fakeClaude.calls.some((c) => c.method === "interrupt")).toBe(false);
  }, 20000);

  it("preserves unrelated frames and normal RPC identities; maps inclusive cursors both ways", () => {
    const root = mkdtempSync("/tmp/ccx-peer-map-");roots.push(root);const config = testConfig({ dataDir: root });
    const b = preparePeerBinding(randomUUID(), randomUUID(), text("hi"));b.nativeUuid = randomUUID();peerBindings(config).save(b);
    const plain = '{"id":7,  "result":{"echo":"unchanged"}}';expect(peerFrame(plain, config)).toBe(plain);
    const quotedId = `{ "id": 9, "result": {"text":"literal ${b.nativeUuid}"} }`;
    expect(peerFrame(quotedId, config)).toBe(quotedId);
    const oversized = JSON.stringify({ id: 8, result: { turnId: b.nativeUuid, text: "large".repeat(30) } });
    expect(peerFrame(oversized, { ...config, rpcLimitBytes: 50 })).toBe(oversized);
    const out = JSON.parse(peerFrame(JSON.stringify({ id: b.nativeUuid, result: { data: [{ id: b.nativeUuid, items: [], status: "completed" }], nextCursor: JSON.stringify({ turnId: b.nativeUuid, includeAnchor: true }) } }), config));
    expect(out.id).toBe(b.nativeUuid);expect(out.result.data[0].id).toBe(b.turnId);expect(JSON.parse(out.result.nextCursor).turnId).toBe(b.turnId);
    const incoming = JSON.parse(peerFrame(JSON.stringify({ id: b.turnId, method: "thread/turns/list", params: { threadId: b.threadId, cursor: out.result.nextCursor } }), config, true));
    expect(incoming.id).toBe(b.turnId);expect(JSON.parse(incoming.params.cursor).turnId).toBe(b.nativeUuid);
  });
});
