import { IncomingMessage } from "http";
import { RequestHandler } from "express";
import { WebSocket, WebSocketServer } from "ws";
import {
  AgentSnapshot,
  HealthReport,
  ServerToWorker,
  WorkerToServer,
} from "@remote-agents/shared";
import { ServerConfig } from "./env";
import { AgentStore } from "./store";
import { tokensEqual } from "./auth";
import { originAllowed } from "./auth";
import { MAX_WS_MESSAGE_BYTES, parseWorkerMessage } from "./validation";

export const WORKER_HEARTBEAT_TIMEOUT_MS = 25_000;
const WORKER_HELLO_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 2 * MAX_WS_MESSAGE_BYTES;

export type UiPush =
  | { type: "health"; payload: HealthReport }
  | { type: "agents"; payload: AgentSnapshot[] }
  | { type: "agent"; payload: AgentSnapshot };

function frameUiMessage(message: UiPush, compact: boolean): string {
  const key = message.type === "health" ? "health" : message.type === "agents" ? "agents" : "agent";
  return JSON.stringify({
    type: message.type,
    [key]: message.payload,
    // Older clients can continue consuming the generic payload alias. The
    // dashboard opts into v2 to avoid sending every transcript twice.
    ...(compact ? {} : { payload: message.payload }),
  });
}

export class UiHub {
  private clients = new Map<WebSocket, boolean>();

  add(ws: WebSocket, compact = false): void {
    this.clients.set(ws, compact);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  sendTo(ws: WebSocket, message: UiPush): void {
    const compact = this.clients.get(ws);
    if (compact === undefined) return;
    this.sendFrame(ws, frameUiMessage(message, compact));
  }

  broadcast(message: UiPush): void {
    // Serialize once per active protocol, not once per browser. With no
    // subscribers there is no transcript serialization work at all.
    const frames = new Map<boolean, string>();
    for (const [client, compact] of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      let data = frames.get(compact);
      if (data === undefined) {
        data = frameUiMessage(message, compact);
        frames.set(compact, data);
      }
      this.sendFrame(client, data);
    }
  }

  private sendFrame(client: WebSocket, data: string): void {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.terminate();
      this.clients.delete(client);
      return;
    }
    client.send(data, (error) => {
      if (error) {
        client.terminate();
        this.clients.delete(client);
      }
    });
  }

  close(): void {
    for (const client of this.clients.keys()) client.close();
    this.clients.clear();
  }
}

export class WorkerRequestError extends Error {
  constructor(readonly code: "WORKER_OFFLINE" | "ACK_TIMEOUT" | "ACK_UNKNOWN", readonly commandId: string) {
    super(code === "WORKER_OFFLINE" ? "Worker unavailable; command was not sent" :
      "Acknowledgement unavailable. The instruction may already be queued or running. Check the agent before retrying.");
    this.name = "WorkerRequestError";
  }
}

type PendingAck = {
  reject: (error: Error) => void;
  resolve: (ack: Extract<WorkerToServer, { type: "ack" }>) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WorkerHub {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingAck>();
  private helloReceived = false;

  constructor(
    private store: AgentStore,
    private ui: UiHub,
    private requestTimeoutMs = 12_000,
    private knownSecrets: readonly string[] = []
  ) {}

  attach(ws: WebSocket): void {
    if (this.socket && this.socket !== ws) {
      this.rejectPending();
      this.socket.removeAllListeners();
      try {
        this.socket.close();
      } catch {
        // ignore
      }
    }
    this.socket = ws;
    this.helloReceived = false;
    this.armTimer(WORKER_HELLO_TIMEOUT_MS);

    ws.on("message", (raw) => {
      this.onMessage(ws, raw.toString());
    });
    ws.on("close", () => this.onSocketGone(ws));
    ws.on("error", () => this.onSocketGone(ws));
  }

  send(message: ServerToWorker): boolean {
    if (
      !this.store.isWorkerConnected() ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      throw new WorkerRequestError("ACK_UNKNOWN", message.commandId);
    }
  }

  request(
    message: ServerToWorker,
    timeoutMs = this.requestTimeoutMs
  ): Promise<Extract<WorkerToServer, { type: "ack" }>> {
    return new Promise((resolve, reject) => {
      if (this.pending.has(message.commandId)) {
        reject(new Error("Duplicate command identifier"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(message.commandId);
        reject(new WorkerRequestError("ACK_TIMEOUT", message.commandId));
      }, timeoutMs);
      this.pending.set(message.commandId, { resolve, reject, timer });
      try {
        if (!this.send(message)) throw new WorkerRequestError("WORKER_OFFLINE", message.commandId);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.commandId);
        reject(error);
      }
    });
  }

  close(): void {
    this.rejectPending();
    this.clearTimer();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.helloReceived = false;
    if (this.store.isWorkerConnected()) {
      this.store.markWorkerDisconnected();
      this.broadcastHealth();
    }
  }

  private onMessage(ws: WebSocket, raw: string): void {
    if (this.socket !== ws) {
      return;
    }
    let parsed: WorkerToServer;
    try {
      parsed = parseWorkerMessage(raw, this.knownSecrets);
    } catch {
      ws.close(1008, "Invalid worker message");
      return;
    }
    if (!this.helloReceived && parsed.type !== "hello") {
      ws.close(1008, "Worker hello required");
      return;
    }
    if (this.helloReceived && parsed.type === "hello") {
      ws.close(1008, "Duplicate worker hello");
      return;
    }

    switch (parsed.type) {
      case "hello":
        this.helloReceived = true;
        this.armTimer();
        this.store.applySnapshot(parsed.health, parsed.agents);
        this.broadcastHealth();
        this.ui.broadcast({ type: "agents", payload: this.store.listAgents() });
        break;
      case "heartbeat":
        this.armTimer();
        this.store.applyHeartbeat(parsed.health, parsed.agents);
        this.broadcastHealth();
        // Empty heartbeats only refresh health; replaying every transcript
        // here defeats the worker's coalesced per-agent update stream.
        if (parsed.agents.length) this.ui.broadcast({ type: "agents", payload: this.store.listAgents() });
        break;
      case "agent_update": {
        const previous = this.store.getAgent(parsed.agent.id);
        this.store.applyAgent(parsed.agent);
        this.ui.broadcast({ type: "agent", payload: parsed.agent });
        if (!previous || previous.status !== parsed.agent.status) this.broadcastHealth();
        break;
      }
      case "ack": {
        const waiter = this.pending.get(parsed.commandId);
        if (waiter) {
          this.pending.delete(parsed.commandId);
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        }
        break;
      }
      default:
        break;
    }
  }

  private onSocketGone(ws: WebSocket): void {
    if (this.socket !== ws) {
      return;
    }
    this.socket = null;
    this.helloReceived = false;
    this.rejectPending();
    this.clearTimer();
    if (this.store.isWorkerConnected()) {
      this.store.markWorkerDisconnected();
      this.broadcastHealth();
    }
  }

  private armTimer(timeoutMs = WORKER_HEARTBEAT_TIMEOUT_MS): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.rejectPending();
      this.store.markWorkerDisconnected();
      this.broadcastHealth();
      if (this.socket) {
        try {
          this.socket.close();
        } catch {
          // ignore
        }
        this.socket = null;
      }
    }, timeoutMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private rejectPending(): void {
    for (const [commandId, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(new WorkerRequestError("ACK_UNKNOWN", commandId)); }
    this.pending.clear();
  }

  private broadcastHealth(): void {
    if (!this.store.isWorkerConnected()) this.ui.broadcast({ type: "agents", payload: this.store.listAgents() });
    this.ui.broadcast({ type: "health", payload: this.store.getHealth() });
  }
}

function workerTokenFromRequest(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (header && header.slice(0, 7).toLowerCase() === "bearer ") {
    return header.slice(7).trim();
  }
  return "";
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url || "/", "http://127.0.0.1").pathname;
  } catch {
    return req.url || "";
  }
}

export function readSessionUser(
  req: IncomingMessage,
  sessionMiddleware: RequestHandler
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (user: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(user);
    };
    const timer = setTimeout(() => finish(null), 2_000);
    const headers: Record<string, unknown> = {};
    const fakeRes = {
      setHeader(name: string, value: unknown) {
        headers[name] = value;
      },
      getHeader(name: string) {
        return headers[name];
      },
      end() {
        finish(null);
        return fakeRes;
      },
    };
    sessionMiddleware(req as never, fakeRes as never, () => {
      const user = (req as IncomingMessage & { session?: { user?: string } })
        .session?.user;
      finish(typeof user === "string" && user ? user : null);
    });
  });
}

function rejectUpgrade(
  socket: { write: (s: string) => void; destroy: () => void },
  status: number,
  reason: string
): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

export function attachWebSockets(
  server: import("http").Server,
  options: {
    config: ServerConfig;
    store: AgentStore;
    workerHub: WorkerHub;
    uiHub: UiHub;
    sessionMiddleware: RequestHandler;
  }
): void {
  const workerWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
  const uiWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const upgrades = new Map<string, number[]>();

  function upgradeAllowed(req: IncomingMessage): boolean {
    const key = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const recent = (upgrades.get(key) || []).filter((value) => now - value < 60_000);
    if (recent.length >= 60) return false;
    recent.push(now);
    upgrades.set(key, recent);
    if (upgrades.size > 10_000) upgrades.delete(upgrades.keys().next().value as string);
    return true;
  }

  workerWss.on("connection", (ws) => {
    options.workerHub.attach(ws);
  });

  uiWss.on("connection", (ws, req) => {
    const compact = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("protocol") === "2";
    options.uiHub.add(ws, compact);
    options.uiHub.sendTo(ws, { type: "health", payload: options.store.getHealth() });
    options.uiHub.sendTo(ws, { type: "agents", payload: options.store.listAgents() });
  });

  server.on("upgrade", (req, socket, head) => {
    const pathname = pathnameOf(req);
    void (async () => {
      if (!upgradeAllowed(req)) {
        rejectUpgrade(socket, 429, "Too Many Requests");
        return;
      }
      if (pathname === "/ws/worker") {
        if (req.headers.origin) {
          rejectUpgrade(socket, 403, "Forbidden");
          return;
        }
        const token = workerTokenFromRequest(req);
        if (!tokensEqual(token, options.config.workerToken)) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        workerWss.handleUpgrade(req, socket, head, (ws) => {
          workerWss.emit("connection", ws, req);
        });
        return;
      }

      if (pathname === "/ws/ui") {
        const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
        if (!originAllowed(origin, options.config)) {
          rejectUpgrade(socket, 403, "Forbidden");
          return;
        }
        const user = await readSessionUser(req, options.sessionMiddleware);
        if (!user) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        uiWss.handleUpgrade(req, socket, head, (ws) => {
          uiWss.emit("connection", ws, req);
        });
        return;
      }

      rejectUpgrade(socket, 404, "Not Found");
    })().catch(() => {
      rejectUpgrade(socket, 500, "Internal Server Error");
    });
  });
}
