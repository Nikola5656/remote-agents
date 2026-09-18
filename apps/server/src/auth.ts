import { scrypt, timingSafeEqual } from "crypto";
import { Request, RequestHandler, Response } from "express";
import session from "express-session";
import FileStoreFactory from "session-file-store";
import fs from "fs";
import { ServerConfig } from "./env";

const FileStore = FileStoreFactory(session);
export const SESSION_COOKIE_NAME = "ra.sid";

declare module "express-session" {
  interface SessionData {
    user?: string;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    if (left.length > 0) {
      timingSafeEqual(left, left);
    }
    return false;
  }
  if (left.length === 0) {
    return true;
  }
  return timingSafeEqual(left, right);
}

function scryptVerify(
  password: string,
  salt: Buffer,
  expected: Buffer
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, expected.length, (err, derived) => {
      if (err) {
        reject(err);
        return;
      }
      if (derived.length !== expected.length) {
        resolve(false);
        return;
      }
      resolve(timingSafeEqual(derived, expected));
    });
  });
}

export async function verifyPassword(
  password: string,
  config: ServerConfig
): Promise<boolean> {
  if (config.passwordHash) {
    const sep = config.passwordHash.indexOf(":");
    if (sep <= 0) {
      return false;
    }
    const saltHex = config.passwordHash.slice(0, sep);
    const hashHex = config.passwordHash.slice(sep + 1);
    if (
      !/^[0-9a-f]{32,128}$/i.test(saltHex) ||
      !/^[0-9a-f]{32,256}$/i.test(hashHex) ||
      saltHex.length % 2 !== 0 ||
      hashHex.length % 2 !== 0
    ) {
      return false;
    }
    try {
      const salt = Buffer.from(saltHex, "hex");
      const expected = Buffer.from(hashHex, "hex");
      if (salt.length === 0 || expected.length === 0) {
        return false;
      }
      return await scryptVerify(password, salt, expected);
    } catch {
      return false;
    }
  }
  if (config.password === undefined) {
    return false;
  }
  return safeEqual(password, config.password);
}

export async function verifyCredentials(
  username: string,
  password: string,
  config: ServerConfig
): Promise<boolean> {
  const passwordOk = await verifyPassword(password, config);
  const userOk = safeEqual(username, config.username);
  return userOk && passwordOk;
}

export function tokensEqual(provided: string, expected: string): boolean {
  if (!expected) {
    return false;
  }
  return safeEqual(provided, expected);
}

export function createSessionMiddleware(config: ServerConfig): RequestHandler {
  fs.mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(config.sessionDir, 0o700);
    if (
      config.environment === "production" &&
      (fs.statSync(config.sessionDir).mode & 0o077) !== 0
    ) {
      throw new Error("Session directory permissions are not private");
    }
  } catch (error) {
    if (config.environment === "production") throw error;
    // The configured store may be on a filesystem without POSIX modes.
  }
  const maxAgeMs = config.sessionDays * 24 * 60 * 60 * 1000;
  return session({
    name: SESSION_COOKIE_NAME,
    store: new FileStore({
      path: config.sessionDir,
      ttl: Math.ceil(maxAgeMs / 1000),
      retries: 1,
      logFn: () => undefined,
    }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: config.publicOrigin.startsWith("https"),
      maxAge: maxAgeMs,
      path: "/",
    },
  });
}

export function requireAuth(req: Request, res: Response, next: () => void): void {
  if (req.session && req.session.user) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

export function createLoginRateLimit(options?: {
  windowMs?: number;
  max?: number;
  maxKeys?: number;
  message?: string;
}): RequestHandler {
  const windowMs = options?.windowMs ?? 15 * 60 * 1000;
  const max = options?.max ?? 8;
  const maxKeys = options?.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(windowMs / 1000))));
      res.status(429).json({ error: options?.message || "Too many login attempts" });
      return;
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > maxKeys) {
      for (const [key, timestamps] of hits) {
        const active = timestamps.filter((t) => now - t < windowMs);
        if (active.length) hits.set(key, active);
        else hits.delete(key);
        if (hits.size <= maxKeys) break;
      }
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value as string);
    }
    next();
  };
}

export function createRateLimit(options: {
  windowMs: number;
  max: number;
  maxKeys?: number;
  message?: string;
}): RequestHandler {
  return createLoginRateLimit({
    windowMs: options.windowMs,
    max: options.max,
    maxKeys: options.maxKeys,
    message: options.message || "Too many requests",
  });
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function originAllowed(origin: string | undefined, config: ServerConfig): boolean {
  if (!config.publicOrigin) return config.environment !== "production";
  if (!origin) return false;
  return originOf(origin) === config.publicOrigin;
}

export function requireSameOrigin(config: ServerConfig): RequestHandler {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    if (!originAllowed(req.get("origin"), config)) {
      res.status(403).json({ error: "Request origin is not allowed" });
      return;
    }
    next();
  };
}
