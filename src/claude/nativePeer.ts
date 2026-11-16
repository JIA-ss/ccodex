import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { v5 as uuidv5 } from "uuid";
import type { Config } from "../config.js";
import type { UserInput } from "../protocol/codex.js";

export interface NativePeerConfig { enabled: true; python: string; script: string; stateDir?: string; softSteerDefault?: boolean }
export interface PeerBinding { jobId: string; threadId: string; turnId: string; clientId: string; input: UserInput[]; nativeUuid?: string; verified?: boolean; steerOf?: string; parentTurnId?: string }
export interface PeerJob { job_id: string; status: string; error?: string; delivery_message_uuid?: string; partial_result?: string; result?: string; transport?: string; expected_native_pid?: number }
const execute = promisify(execFile);

/** Explicit opt-in sidecar also permits enabling this path without restarting a live gateway. */
export function nativePeerConfig(config: Config): NativePeerConfig | undefined {
  try {
    const value = JSON.parse(readFileSync(join(config.productHome, "native-peer-bridge.json"), "utf8"));
    if (value.enabled === true && typeof value.python === "string" && typeof value.script === "string") return value;
  } catch {}
  return undefined;
}

export class PeerBindings {
  public readonly jobs: Map<string, PeerBinding>;
  public readonly nativeIds = new Set<string>();
  public readonly logicalIds = new Set<string>();
  public constructor(private readonly file: string) {
    let data: PeerBinding[] = [];
    try { const parsed = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(parsed)) data = parsed; } catch {}
    this.jobs = new Map(data.map((binding) => [binding.jobId, binding]));
    for (const binding of data) { this.logicalIds.add(binding.turnId); if (binding.nativeUuid) this.nativeIds.add(binding.nativeUuid); }
  }
  public save(binding: PeerBinding): void {
    this.jobs.set(binding.jobId, binding);
    this.logicalIds.add(binding.turnId);
    if (binding.nativeUuid) this.nativeIds.add(binding.nativeUuid);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.jobs.values()]), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
const stores = new Map<string, PeerBindings>();
export function peerBindings(config: Config): PeerBindings {
  const file = join(config.dataDir, "native-peer-turns.json");
  let value = stores.get(file);
  if (!value) { value = new PeerBindings(file); stores.set(file, value); }
  return value;
}

export function preparePeerBinding(threadId: string, clientId: unknown, input: UserInput[]): PeerBinding {
  if (typeof clientId !== "string" || !clientId || clientId.length > 120) throw new Error("Shared App input requires a stable client message identifier; no message was sent.");
  if (!input.length || input.some((item) => item.type !== "text")) throw new Error("The original App connection currently accepts text only; no attachment was sent.");
  const text = input.map((item) => item.type === "text" ? item.text : "").join("\n");
  if (!text.trim() || text.length > 100_000) throw new Error("Shared App input must be nonempty text under 100,000 characters; nothing was sent.");
  const requestId = `ccodex-native-peer:${threadId}:${clientId}`;
  return { jobId: createHash("sha256").update(requestId).digest("hex").slice(0, 32), threadId,
    turnId: uuidv5(requestId, uuidv5.URL), clientId, input };
}

export async function submitPeer(bridge: NativePeerConfig, binding: PeerBinding, ownerPid: number, mode: string, cwd: string): Promise<PeerJob> {
  const prompt = binding.input.map((item) => item.type === "text" ? item.text : "").join("\n");
  const args = { session_id: binding.threadId, prompt, request_id: `ccodex-native-peer:${binding.threadId}:${binding.clientId}`,
    permission_mode: mode, directory: cwd, timeout_seconds: 900, require_native: true, expected_native_pid: ownerPid,
    ...(binding.steerOf ? { steer_of: binding.steerOf } : {}) };
  const state = bridge.stateDir ?? join(homedir(), ".local", "state", "claude-sessions-bridge");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const payload = join(state, `${binding.jobId}.request.json`), temporary = `${payload}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(args), { mode: 0o600 });
  renameSync(temporary, payload);
  let stdout: string;
  try { ({ stdout } = await execute(bridge.python, [bridge.script, "continue", `@${payload}`], {
      env: { ...process.env, ...(bridge.stateDir ? { CLAUDE_BRIDGE_STATE: bridge.stateDir } : {}) }, timeout: 20_000, maxBuffer: 1_000_000,
    }));
  } catch {
    // The worker may already exist even if its caller lost the acknowledgement.
    // Reconcile the same durable job, never log/replay a command containing the prompt.
    try { return await readPeerJob(bridge, binding); } catch {}
    throw new Error("Native App submission was not acknowledged; inspect the original chat before retrying. No automatic resend.");
  }
  const reply = JSON.parse(stdout) as PeerJob;
  if (reply.job_id !== binding.jobId) throw new Error("Native App job identity mismatch; reconcile before retrying.");
  return reply;
}
export async function readPeerJob(bridge: NativePeerConfig, binding: PeerBinding): Promise<PeerJob> {
  const root = bridge.stateDir ?? join(homedir(), ".local", "state", "claude-sessions-bridge");
  const job = JSON.parse(await readFile(join(root, `${binding.jobId}.json`), "utf8"));
  if (job.job_id !== binding.jobId || (job.transport && job.transport !== "native_peer")) throw new Error("Unexpected shared App transport");
  if (job.session_id !== binding.threadId || job.prompt !== binding.input.map((item) => item.type === "text" ? item.text : "").join("\n")) throw new Error("Shared App job payload conflict; no message was retried.");
  return job;
}

/** Keep native canonical IDs and the client's pending message IDs consistent across refresh and paging. */
export function peerFrame(text: string, config: Config, incoming = false): string {
  const store = peerBindings(config);
  if (!store.jobs.size) return text;
  // Most frames belong to GPT or a normal SDK turn. Do not parse/rebuild them,
  // or allocate a list of every historical shared message per token delta.
  if (config.rpcLimitBytes && Buffer.byteLength(text) > config.rpcLimitBytes) return text;
  const relevant = incoming ? store.logicalIds : store.nativeIds;
  const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu) ?? [];
  if (!uuids.some((id) => relevant.has(id)) && (incoming || !text.includes("[Codex bridge request "))) return text;
  const jobs = [...store.jobs.values()];
  if (incoming) {
    try { if (!["thread/turns/list", "thread/items/list", "thread/revert", "thread/fork", "thread/searchOccurrences"].includes(JSON.parse(text).method)) return text; } catch { return text; }
  }
  let changed = false;
  const ids = new Map(jobs.filter((x) => x.nativeUuid).map((x) => incoming ? [x.turnId, x.nativeUuid!] : [x.nativeUuid!, x.turnId]));
  const replaceId = (value: string) => {
    for (const [from, to] of ids) if (value === from || value.startsWith(from + ":")) { changed = true; return to + value.slice(from.length); }
    return value;
  };
  const walk = (value: any, key = "", root = false): any => {
    if (typeof value === "string") {
      if (key.toLowerCase().includes("cursor") && value.startsWith("{")) { try { return JSON.stringify(walk(JSON.parse(value))); } catch {} }
      return ["id", "turnId", "itemId", "beforeTurnId", "afterTurnId"].includes(key) && !root ? replaceId(value) : value;
    }
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const list = value.map((v) => walk(v));
      if (!incoming && list.every((v) => v && typeof v.id === "string" && Array.isArray(v.items) && typeof v.status === "string")) {
        const unique = new Map<string, any>();
        for (const turn of list) {
          const previous = unique.get(turn.id);
          if (!previous) unique.set(turn.id, turn);
          else { changed = true; const richer = previous.items.length >= turn.items.length ? previous : turn; unique.set(turn.id, { ...richer, ...(turn.status === "inProgress" || previous.status === "inProgress" ? { status: "inProgress", completedAt: null } : {}) }); }
        }
        return [...unique.values()];
      }
      return list;
    }
    if (!incoming && value.type === "userMessage") {
      const body = JSON.stringify(value.content ?? []);
      const binding = jobs.find((b) => b.nativeUuid === value.id || (!b.nativeUuid && body.includes("Message from Claude agent Codex session bridge") && body.includes(`[Codex bridge request ${b.jobId}]`)));
      if (binding) {
        if (!binding.nativeUuid && typeof value.id === "string") { binding.nativeUuid = value.id; peerBindings(config).save(binding); ids.set(value.id, binding.turnId); }
        changed = true;
        return { ...value, id: binding.turnId, clientId: binding.clientId, content: binding.input };
      }
    }
    const out: any = {};
    // Children may discover the native message UUID before the parent's turn ID is rewritten.
    for (const [k, v] of Object.entries(value)) if (k !== "id") out[k] = walk(v, k);
    if ("id" in value) out.id = root ? value.id : walk(value.id, "id");
    return out;
  };
  try { const result = walk(JSON.parse(text), "", true); return changed ? JSON.stringify(result) : text; } catch { return text; }
}
