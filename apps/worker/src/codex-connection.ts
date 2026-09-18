import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/** Codex's documented JSON-RPC app server. Unlike exec, it creates sidebar-visible sessions. */
export class CodexConnection {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ended = false;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  private closing?: Promise<void>;
  onNotification?: (method: string, params: any) => void;
  onClose?: () => void;
  constructor(bin: string, cwd: string) {
    const env = { ...process.env };
    delete env.CODEX_THREAD_ID;
    this.child = spawn(bin, ["app-server"], { cwd, env, stdio: "pipe" });
    this.child.stdin.on("error", () => undefined);
    this.child.stderr.resume();
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && !msg.method) {
        const p = this.pending.get(String(msg.id));
        if (!p) return;
        this.pending.delete(String(msg.id)); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.id != null) {
        // Never silently approve requests originating in the model. The remote UI
        // does not have an approval editor; return an actionable error instead.
        this.child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601,
          message: "This request requires the Codex desktop. Open this task in Codex to continue." } }) + "\n");
      } else this.onNotification?.(msg.method, msg.params);
    });
    const close = () => {
      if (this.ended) return;
      this.ended = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex app server disconnected")); }
      this.pending.clear(); this.onClose?.();
    };
    this.child.once("error", close); this.child.once("close", () => { close(); this.resolveClosed(); });
  }
  async initialize() {
    await this.rpc("initialize", { clientInfo: { name: "remote-agents", version: "1.1.0" }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  rpc(method: string, params: any): Promise<any> {
    if (this.ended) return Promise.reject(new Error("Codex app server disconnected"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; check the task before retrying`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.child.stdin.end();
      this.child.kill();
      const force = setTimeout(() => this.child.kill("SIGKILL"), 2000);
      try { await this.closed; } finally { clearTimeout(force); }
    })();
  }
}

/** Local desktop follower protocol, used when Codex already owns the conversation.
 * Frames are a uint32 little-endian byte length followed by a JSON payload.
 * Keep this isolated: protocol versions belong to the installed desktop release.
 */
export class CodexDesktopConnection {
  onClose?: () => void;
  private socket?: net.Socket;
  private clientId = "initializing-client";
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly socketPath?: string) {}
  async connect() {
    const socketPath = this.socketPath || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "ipc", "ipc.sock");
    await new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection(socketPath, resolve);
      this.socket.once("error", reject);
      this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
      this.socket.on("close", () => {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex desktop disconnected")); }
        this.pending.clear();
        this.onClose?.();
      });
    });
    this.clientId = (await this.rpc("initialize", { clientType: "remote-agents" }, 0)).clientId;
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > 256 * 1024 * 1024) { this.close(); return; }
      if (this.buffer.length < length + 4) return;
      let message: any;
      try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString()); } catch { this.close(); return; }
      this.buffer = this.buffer.subarray(length + 4);
      if (message.type === "client-discovery-request") {
        this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
      } else if (message.type === "response") {
        const p = this.pending.get(message.requestId);
        if (!p) continue;
        this.pending.delete(message.requestId); clearTimeout(p.timer);
        message.resultType === "success" ? p.resolve(message.result) : p.reject(new Error(message.error));
      }
    }
  }
  private write(message: any) {
    const data = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
    this.socket?.write(Buffer.concat([header, data]));
  }
  rpc(method: string, params: any, version: number, timeoutMs = 25000): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Codex desktop ${method} timed out; check the task before retrying`)); }, timeoutMs + 1000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: "request", requestId, sourceClientId: this.clientId, method, params, version, timeoutMs });
    });
  }
  async owns(threadId: string): Promise<boolean> {
    try { await this.rpc("thread-owner-discovery", { hostId: "local", conversationId: threadId }, 1, 2000); return true; }
    catch (e) { if (e instanceof Error && /^(no-client-found|request-timeout)$|thread-owner-discovery timed out/.test(e.message)) return false; throw e; }
  }
  close() { this.socket?.destroy(); }
}

/** Ask the desktop to hydrate the SAME conversation when its backend retained
 * the writer lock after its view was unloaded. Never pass a prompt in this URL. */
export async function wakeCodexDesktop(threadId: string): Promise<void> {
  if (process.platform !== "darwin" || !/^[0-9a-f-]{36}$/.test(threadId)) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-g", `codex://threads/${threadId}`], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Could not reconnect the Codex desktop")));
  });
}
