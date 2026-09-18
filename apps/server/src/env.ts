import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  passwordHash?: string;
  sessionSecret: string;
  sessionDays: number;
  workerToken: string;
  publicOrigin: string;
  sessionDir: string;
  environment?: "development" | "test" | "production";
  trustProxy?: false | number;
  workerRequestTimeoutMs?: number;
}

const MIN_SECRET_BYTES = 32;

function requiredInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function normalizedOrigin(value: string): string {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute http(s) origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PUBLIC_ORIGIN must contain only scheme, host, and optional port");
  }
  return url.origin;
}

function trustProxyFromEnv(value: string | undefined): false | number {
  if (!value || value === "0" || value.toLowerCase() === "false") return false;
  if (!/^\d+$/.test(value)) {
    throw new Error("TRUST_PROXY must be false, 0, or a hop count from 1 to 10");
  }
  const hops = Number(value);
  if (hops < 1 || hops > 10) {
    throw new Error("TRUST_PROXY must be false, 0, or a hop count from 1 to 10");
  }
  return hops;
}

function validateProduction(config: ServerConfig): void {
  if (config.environment !== "production") return;
  if (!process.env.SESSION_SECRET || Buffer.byteLength(config.sessionSecret) < MIN_SECRET_BYTES) {
    throw new Error("Production SESSION_SECRET must be explicitly set and at least 32 bytes");
  }
  if (Buffer.byteLength(config.sessionSecret) > 512) {
    throw new Error("Production SESSION_SECRET must not exceed 512 bytes");
  }
  if (!config.passwordHash || config.password) {
    throw new Error("Production requires APP_PASSWORD_HASH and forbids APP_PASSWORD");
  }
  if (!/^[0-9a-f]{32,128}:[0-9a-f]{32,256}$/i.test(config.passwordHash)) {
    throw new Error("Production APP_PASSWORD_HASH must be a bounded salt:hash hex value");
  }
  if (Buffer.byteLength(config.workerToken) < MIN_SECRET_BYTES) {
    throw new Error("Production WORKER_TOKEN must be at least 32 bytes");
  }
  if (Buffer.byteLength(config.workerToken) > 512) {
    throw new Error("Production WORKER_TOKEN must not exceed 512 bytes");
  }
  if (!config.publicOrigin || !config.publicOrigin.startsWith("https://")) {
    throw new Error("Production PUBLIC_ORIGIN must be an explicit HTTPS origin");
  }
  const secrets = [config.sessionSecret, config.workerToken, config.passwordHash];
  if (new Set(secrets).size !== secrets.length) {
    throw new Error("Production authentication secrets must be distinct");
  }
  if (!path.isAbsolute(config.sessionDir)) {
    throw new Error("Production SESSION_DIR must be an absolute path");
  }
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const cleaned = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = cleaned.slice(0, eq).trim();
    const val = stripQuotes(cleaned.slice(eq + 1).trim());
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

export function loadEnv(): void {
  const packageRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(packageRoot, "../..");
  loadEnvFile(path.join(repoRoot, ".env"));
  loadEnvFile(path.join(packageRoot, ".env"));
  loadEnvFile(path.join(process.cwd(), ".env"));
}

export function configFromEnv(): ServerConfig {
  const username = process.env.APP_USERNAME || "";
  const password = process.env.APP_PASSWORD || undefined;
  const passwordHash = process.env.APP_PASSWORD_HASH || undefined;
  if (!username) {
    throw new Error("APP_USERNAME is required");
  }
  if (!password && !passwordHash) {
    throw new Error("APP_PASSWORD or APP_PASSWORD_HASH is required");
  }

  let sessionSecret = process.env.SESSION_SECRET || "";
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("hex");
    console.warn(
      "SESSION_SECRET is not set; using an ephemeral secret (sessions will not survive restarts)"
    );
  }

  const sessionDays = requiredInteger("SESSION_DAYS", process.env.SESSION_DAYS, 30, 1, 30);
  const port = requiredInteger("PORT", process.env.PORT, 3847, 0, 65535);
  const rawEnvironment = process.env.NODE_ENV || "production";
  if (!new Set(["development", "test", "production"]).has(rawEnvironment)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  const environment = rawEnvironment as ServerConfig["environment"];
  const config: ServerConfig = {
    host: process.env.HOST || "127.0.0.1",
    port,
    username,
    password,
    passwordHash,
    sessionSecret,
    sessionDays,
    workerToken: process.env.WORKER_TOKEN || "",
    publicOrigin: normalizedOrigin(process.env.PUBLIC_ORIGIN || ""),
    sessionDir:
      process.env.SESSION_DIR ||
      path.resolve(__dirname, "../data/sessions"),
    environment,
    trustProxy: trustProxyFromEnv(process.env.TRUST_PROXY),
    workerRequestTimeoutMs: requiredInteger(
      "WORKER_REQUEST_TIMEOUT_MS",
      process.env.WORKER_REQUEST_TIMEOUT_MS,
      12_000,
      1_000,
      60_000
    ),
  };
  if (Buffer.byteLength(username) > 128) throw new Error("APP_USERNAME is too long");
  if (/\p{C}/u.test(username)) throw new Error("APP_USERNAME contains control characters");
  if (!config.host.trim() || config.host.length > 255 || /\s/.test(config.host)) {
    throw new Error("HOST must be a non-empty hostname or address");
  }
  if (!config.workerToken && environment === "production") {
    throw new Error("WORKER_TOKEN is required in production");
  }
  validateProduction(config);
  return config;
}
