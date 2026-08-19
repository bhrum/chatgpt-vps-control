import { spawn } from "node:child_process";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_LINE_BYTES = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 65_000;
let activeService = null;
let nextId = 1;

class NativeRequestService {
  constructor({ command, args, env }) {
    this.specKey = JSON.stringify([command, args]);
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.resume();
    this.child.on("error", (error) => this.close(error));
    this.child.on("close", () => this.close(new Error("Native request service exited.")));
    this.child.unref();
    this.child.stdin.unref?.();
    this.child.stdout.unref?.();
    this.child.stderr.unref?.();
  }

  onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_LINE_BYTES) {
      this.child.kill();
      this.close(new Error("Native request service response exceeded its size limit."));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok === true && response.result && typeof response.result === "object") pending.resolve(response.result);
      else pending.reject(new Error(response.error || "Native request service failed."));
    }
  }

  request(payload) {
    if (this.closed) return Promise.reject(new Error("Native request service is closed."));
    const id = nextId++;
    const line = `${JSON.stringify({ id, command: "request", payload })}\n`;
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return Promise.reject(new Error("Native request exceeds the service size limit."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill();
        this.close(new Error("Native request service timed out."));
        reject(new Error("Native request service timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(line, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (activeService === this) activeService = null;
  }
}

export async function nativeServiceRequest(spec, payload) {
  const key = JSON.stringify([spec.command, spec.args]);
  if (!activeService || activeService.closed || activeService.specKey !== key) {
    if (activeService && !activeService.closed) activeService.child.kill();
    activeService = new NativeRequestService(spec);
  }
  return activeService.request(payload);
}

export function closeNativeRequestService() {
  if (!activeService) return;
  const service = activeService;
  activeService = null;
  service.child.kill();
  service.close(new Error("Native request service closed."));
}
