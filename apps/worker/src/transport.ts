import type { AgentSnapshot, HealthReport, ServerToWorker, WorkerToServer } from "@remote-agents/shared";
import WebSocket from "ws";
import type { WorkerConfig } from "./config";
import { workerWsUrl } from "./config";
import { log, logError } from "./log";

const BACKOFF_START = 1000;
const BACKOFF_MAX = 30_000;
const UPDATE_INTERVAL_MS = 250;
const MAX_BUFFERED_BYTES = 256 * 1024;

export interface TransportHandlers {
  health: () => HealthReport;
  agents: () => AgentSnapshot[];
  onCommand: (
    msg: ServerToWorker
  ) => Promise<Extract<WorkerToServer, { type: "ack" }> | void | {
    files?: Extract<WorkerToServer, { type: "ack" }>["files"];
    file?: Extract<WorkerToServer, { type: "ack" }>["file"];
  }>;
}

export class WorkerTransport {
  private ws: WebSocket | null = null;
  private backoff = BACKOFF_START;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private updateTimer: NodeJS.Timeout | null = null;
  private pendingUpdates = new Map<string, AgentSnapshot>();
  private lastHeartbeatAt: number | null = null;
  connected = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly handlers: TransportHandlers
  ) {}

  get lastHeartbeat(): number | null {
    return this.lastHeartbeatAt;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    this.pendingUpdates.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.connected = false;
  }

  sendAgentUpdate(agent: AgentSnapshot): void {
    if (!this.connected) return; // The reconnect hello carries the latest snapshot.
    this.pendingUpdates.set(agent.id, agent);
    this.scheduleUpdates();
  }

  private scheduleUpdates(): void {
    if (this.updateTimer || this.stopped || !this.pendingUpdates.size) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      for (const [id, agent] of this.pendingUpdates) {
        // Keep only the newest state while the network drains. Never build an
        // unbounded queue of increasingly large transcript snapshots.
        if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) break;
        this.pendingUpdates.delete(id);
        this.send({ type: "agent_update", agent });
      }
      this.scheduleUpdates();
    }, UPDATE_INTERVAL_MS);
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.config.serverUrl) {
      logError("SERVER_URL missing; will retry");
      this.scheduleReconnect();
      return;
    }
    if (!this.config.workerToken) {
      logError("WORKER_TOKEN missing; will retry");
      this.scheduleReconnect();
      return;
    }

    const url = workerWsUrl(this.config.serverUrl);
    log("connecting", url, this.config.serverHost ? `host ${this.config.serverHost}` : "");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.workerToken}`,
    };
    if (this.config.serverHost) {
      headers.Host = this.config.serverHost;
    }
    const wsOptions: WebSocket.ClientOptions & { servername?: string } = {
      headers,
      handshakeTimeout: 10_000,
      maxPayload: 2 * 1024 * 1024,
    };
    if (this.config.serverHost) {
      // When SERVER_URL is an IP (local DNS lag), verify the cert as SERVER_HOST.
      wsOptions.servername = this.config.serverHost;
    }
    const ws = new WebSocket(url, wsOptions);
    this.ws = ws;

    ws.on("open", () => {
      if (this.stopped || this.ws !== ws) { ws.close(); return; }
      this.connected = true;
      this.backoff = BACKOFF_START;
      this.lastHeartbeatAt = Date.now();
      log("connected to control server");
      this.pendingUpdates.clear();
      this.send({
        type: "hello",
        workerId: this.config.workerId,
        health: this.handlers.health(),
        agents: this.handlers.agents(),
      });
      this.startHeartbeat();
    });

    ws.on("message", (data) => {
      if (this.ws === ws) void this.onMessage(data.toString());
    });

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.clearHeartbeat();
      log("socket closed", code, reason.toString());
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      logError("socket error", err);
    });
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: ServerToWorker;
    try {
      msg = JSON.parse(raw) as ServerToWorker;
    } catch {
      logError("invalid JSON from server", raw.slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== "object" || !("type" in msg) || !("commandId" in msg)) {
      logError("unexpected server message", raw.slice(0, 200));
      return;
    }
    try {
      const extra = await this.handlers.onCommand(msg);
      this.send({
        type: "ack",
        commandId: msg.commandId,
        ok: true,
        ...(extra && typeof extra === "object" ? extra : {}),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logError("command failed", msg.type, error);
      this.send({ type: "ack", commandId: msg.commandId, ok: false, error });
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.lastHeartbeatAt = Date.now();
      this.send({
        type: "heartbeat",
        health: this.handlers.health(),
        // The server retains agent snapshots from hello and agent_update.
        // Heartbeats must stay small even after days of agent output.
        agents: [],
      });
    }, this.config.heartbeatMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2);
    log("reconnect in", delay, "ms");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(msg: WorkerToServer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      logError("send failed", err);
    }
  }
}
