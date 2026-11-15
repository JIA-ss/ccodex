import { createConnection } from "node:net";
import WebSocket from "ws";

/** A missing response is not evidence of idleness. Never stop a live gateway on an unknown state. */
export async function assertGatewayIdle(socketPath: string): Promise<void> {
  const socket = new WebSocket("ws://ccodex/rpc", { createConnection: () => createConnection(socketPath), perMessageDeflate: false });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let next = 0;
  socket.on("error", () => undefined);
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.id === undefined || message.method) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error.message));
    else request?.resolve(message.result);
  });
  const request = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Idle check timed out: ${method}`)); }, 2_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Idle check could not connect")), 2_000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    await request("initialize", { clientInfo: { name: "ccodex_idle_check", version: "1" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
    const loaded = await request("thread/loaded/list");
    if (!Array.isArray(loaded.data)) throw new Error("Loaded chat state is unknown");
    for (const threadId of loaded.data) {
      const { thread } = await request("thread/read", { threadId, includeTurns: false });
      if (!thread || !["idle", "notLoaded"].includes(thread.status?.type)) {
        throw new Error("Refusing gateway restart: a GPT or Claude chat is active or its status is unknown");
      }
    }
  } finally { socket.terminate(); }
}
