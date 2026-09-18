import express, { Express } from "express";
import helmet from "helmet";
import fs from "fs";
import path from "path";
import { ServerConfig } from "./env";
import { AgentStore } from "./store";
import {
  createLoginRateLimit,
  createRateLimit,
  createSessionMiddleware,
  requireAuth,
  requireSameOrigin,
} from "./auth";
import { createApiRouter } from "./routes";
import { WorkerHub } from "./ws";

export function createApp(options: {
  config: ServerConfig;
  store: AgentStore;
  workerHub: WorkerHub;
}): { app: Express; sessionMiddleware: express.RequestHandler } {
  const { config, store, workerHub } = options;
  const app = express();
  app.disable("x-powered-by");
  // The API only accepts scalar query parameters; avoid the complex `qs` parser.
  app.set("query parser", "simple");
  app.set("trust proxy", config.trustProxy || false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'none'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
    })
  );
  app.use(requireSameOrigin(config));

  const loginRateLimit = createLoginRateLimit();
  app.use("/api/login", loginRateLimit);
  app.use(
    "/api",
    createRateLimit({
      windowMs: 60_000,
      max: 300,
      message: "Too many API requests",
    })
  );
  const mutationRateLimit = createRateLimit({
    windowMs: 60_000,
    max: 60,
    message: "Too many mutation requests",
  });
  app.use(
    "/api",
    (req, res, next) => {
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
      return mutationRateLimit(req, res, next);
    }
  );
  app.use(
    express.json({ limit: "256kb", strict: true, type: "application/json" })
  );

  const sessionMiddleware = createSessionMiddleware(config);
  app.use(sessionMiddleware);

  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use("/api", (req, res, next) => {
    if (req.path === "/login" || req.path === "/healthz") {
      next();
      return;
    }
    requireAuth(req, res, next);
  });

  app.use(
    "/api",
    createApiRouter({
      config,
      store,
      workerHub,
    })
  );

  const webDist = path.resolve(__dirname, "../../web/dist");
  const publicDir = path.resolve(__dirname, "../public");
  const staticOptions = {
    index: "index.html",
    setHeaders(res: express.Response, file: string) {
      if (path.extname(file).toLowerCase() === ".html") {
        res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
      }
    },
  };
  if (fs.existsSync(webDist)) app.use(express.static(webDist, staticOptions));
  if (fs.existsSync(publicDir)) app.use(express.static(publicDir, staticOptions));

  // An old tab may request a lazy chunk removed by a newer deployment. Never
  // answer that module request with the SPA's HTML or cache its missing result.
  app.use("/assets", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "Asset not found" });
  });

  app.use((req, res) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const candidates = [
      path.join(webDist, "index.html"),
      path.join(publicDir, "index.html"),
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
        res.sendFile(file);
        return;
      }
    }
    res.status(404).send("Not found");
  });

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status?: unknown }).status)
          : 500;
      if (status === 400 || status === 413 || status === 415) {
        res
          .status(status)
          .json({
            error:
              status === 413 ? "Request body is too large" : "Invalid request body",
          });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  );

  return { app, sessionMiddleware };
}
