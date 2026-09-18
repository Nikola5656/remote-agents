import http from "http";
import { ServerConfig } from "./env";
import { AgentStore } from "./store";
import { createApp } from "./app";
import { attachWebSockets, UiHub, WorkerHub } from "./ws";

export interface StartedServer {
  server: http.Server;
  store: AgentStore;
  workerHub: WorkerHub;
  uiHub: UiHub;
  host: string;
  port: number;
  close: () => Promise<void>;
}

export function createServer(config: ServerConfig): {
  server: http.Server;
  store: AgentStore;
  workerHub: WorkerHub;
  uiHub: UiHub;
} {
  const store = new AgentStore();
  const uiHub = new UiHub();
  const workerHub = new WorkerHub(
    store,
    uiHub,
    config.workerRequestTimeoutMs ?? 12_000,
    [config.workerToken, config.sessionSecret, config.password || "", config.passwordHash || ""]
  );
  const { app, sessionMiddleware } = createApp({
    config,
    store,
    workerHub,
  });
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  attachWebSockets(server, {
    config,
    store,
    workerHub,
    uiHub,
    sessionMiddleware,
  });
  return { server, store, workerHub, uiHub };
}

export function startServer(config: ServerConfig): Promise<StartedServer> {
  const created = createServer(config);
  const { server, store, workerHub, uiHub } = created;

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      const addr = server.address();
      const port =
        typeof addr === "object" && addr ? addr.port : config.port;
      resolve({
        server,
        store,
        workerHub,
        uiHub,
        host: config.host,
        port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            workerHub.close();
            uiHub.close();
            server.close((err) => {
              if (err) {
                closeReject(err);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}
