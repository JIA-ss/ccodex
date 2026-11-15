/** Rebind a lost Unix pathname in place; never stop a gateway or replace an existing pathname. */
export function installListenerGuard(socketPath: string, intervalMs = 250, primary?: import("node:http").Server): { pid: number; installed: boolean; stop(): void } {
  const fs = process.getBuiltinModule("node:fs");
  const http = process.getBuiltinModule("node:http");
  const key = Symbol.for("ccodex.listener-guard.v1");
  const global = globalThis as typeof globalThis & { [key: symbol]: any };
  const registry: Map<string, { pid: number; installed: boolean; stop(): void }> = global[key] ??= new Map();
  const existing = registry.get(socketPath);
  if (existing) return existing;
  if (!Number.isInteger(intervalMs) || intervalMs < 10) throw new Error("Invalid listener guard interval");
  const handles = (process as NodeJS.Process & { _getActiveHandles(): any[] })._getActiveHandles();
  const candidates = primary ? [primary] : handles.filter((handle) => handle.constructor?.name === "Server"
    && handle.address?.() === socketPath && handle.listeners("upgrade").length > 0);
  if (candidates.length !== 1) throw new Error("Expected exactly one existing gateway listener");
  const original = candidates[0]!;
  const recovered = new Set<import("node:http").Server>();
  let stopping = false;
  let binding = false;
  const log = (message: string, details: Record<string, unknown> = {}) => process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "info", message, pid: process.pid, ...details })}\n`);
  const tick = () => { try {
    if (stopping || binding || fs.lstatSync(socketPath, { throwIfNoEntry: false })) return;
    if (!original.listening) return;
    binding = true;
    const replacement = http.createServer();
    for (const event of ["request", "upgrade", "clientError", "checkContinue", "checkExpectation"]) {
      for (const listener of original.listeners(event)) replacement.on(event, listener as (...args: any[]) => void);
    }
    replacement.on("error", (error: NodeJS.ErrnoException) => {
      binding = false;
      log("listener.guard.bind-failed", { code: error.code ?? "unknown" });
    });
    replacement.listen(socketPath, () => {
      recovered.add(replacement);
      binding = false;
      if (stopping) { replacement.close(); return; }
      try { fs.chmodSync(socketPath, 0o600); } catch (error) {
        log("listener.guard.mode-failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
      }
      log("listener.guard.rebound", { socketPath, inPlace: true });
    });
  } catch (error) {
    binding = false;
    log("listener.guard.check-failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
  }};
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const stop = () => {
    stopping = true;
    clearInterval(timer);
    for (const server of recovered) server.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (registry.get(socketPath) === result) registry.delete(socketPath);
  };
  process.prependOnceListener("SIGTERM", stop);
  process.prependOnceListener("SIGINT", stop);
  const result = { pid: process.pid, installed: true, stop };
  registry.set(socketPath, result);
  log("listener.guard.installed", { socketPath, intervalMs });
  tick();
  return result;
}
