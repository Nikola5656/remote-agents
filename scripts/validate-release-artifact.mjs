#!/usr/bin/env node

import { createHash, randomBytes, scryptSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const [archiveArg, checksumArg] = process.argv.slice(2);
if (!archiveArg || !checksumArg) {
  throw new Error("usage: node scripts/validate-release-artifact.mjs <release.tgz> <release.tgz.sha256>");
}

const archive = path.resolve(archiveArg);
const checksumFile = path.resolve(checksumArg);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "remote-agents-artifact-smoke-"));
let server;

function hash(data) {
  return createHash("sha256").update(data).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function safeArchivePath(value) {
  if (!value || value.includes("\\") || value.startsWith("/") || value.includes("\0")) return false;
  const parts = value.replace(/\/$/, "").split("/");
  return parts[0] === "remote-agents" && parts.every((part) => part && part !== "." && part !== "..");
}

function assertNoSensitivePath(relative) {
  const lower = relative.toLowerCase();
  const parts = lower.split("/");
  const base = parts.at(-1);
  const allowedEnv = new Set([".env.example", "deploy/env.server.example"]);
  if (
    parts.includes(".git") ||
    parts.includes("node_modules") ||
    parts.includes("data") ||
    parts.includes("sessions") ||
    parts.includes(".remote-agents") ||
    parts.includes("src") ||
    base === "credentials.json" ||
    base.endsWith(".credentials.json") ||
    base === ".cursor-api-key" ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    (base.startsWith(".env") && !allowedEnv.has(lower))
  ) {
    throw new Error(`release contains forbidden secret/state/source path: ${relative}`);
  }
}

function walk(root, current = root, output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`release contains symlink: ${relative}`);
    if (entry.isDirectory()) walk(root, absolute, output);
    else if (entry.isFile()) output.push(relative);
    else throw new Error(`release contains special file: ${relative}`);
  }
  return output;
}

function verifyHighConfidenceSecrets(root, files) {
  const signatures = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{32,}\b/,
  ];
  for (const relative of files) {
    const data = fs.readFileSync(path.join(root, relative));
    if (data.includes(0)) continue;
    const text = data.toString("utf8");
    if (signatures.some((signature) => signature.test(text))) {
      throw new Error(`release contains a high-confidence secret signature: ${relative}`);
    }
  }
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`packaged server startup timed out:\n${output}`)), 15_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Control API listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`packaged server exited before listening (${code ?? signal}):\n${output}`));
    });
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, { redirect: "manual", ...options });
  return response;
}

try {
  const expectedLine = fs.readFileSync(checksumFile, "utf8").trim();
  const checksumMatch = expectedLine.match(/^([0-9a-f]{64})\s{2}([^/]+)$/i);
  if (!checksumMatch || checksumMatch[2] !== path.basename(archive)) {
    throw new Error("checksum sidecar must contain one SHA-256 and the exact archive basename");
  }
  const actualArchiveHash = hash(fs.readFileSync(archive));
  if (actualArchiveHash !== checksumMatch[1].toLowerCase()) throw new Error("archive SHA-256 mismatch");

  const listing = run("tar", ["-tzf", archive]).split(/\r?\n/).filter(Boolean);
  if (!listing.length || listing.some((entry) => !safeArchivePath(entry))) {
    throw new Error("archive contains an unsafe or unexpected root path");
  }
  for (const entry of listing) {
    const relative = entry.replace(/^remote-agents\/?/, "").replace(/\/$/, "");
    if (relative) assertNoSensitivePath(relative);
  }

  run("tar", ["-xzf", archive, "-C", temporary]);
  const releaseRoot = path.join(temporary, "remote-agents");
  const manifestPath = path.join(releaseRoot, "RELEASE-MANIFEST.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.formatVersion !== 1 || !/^[0-9a-f]{40}$/i.test(manifest.commit)) {
    throw new Error("invalid release manifest version or commit");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("empty release manifest");

  const declared = new Set();
  for (const item of manifest.files) {
    if (
      !item ||
      typeof item.path !== "string" ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      !/^[0-9a-f]{64}$/i.test(item.sha256) ||
      declared.has(item.path)
    ) {
      throw new Error("invalid or duplicate release manifest entry");
    }
    assertNoSensitivePath(item.path);
    const absolute = path.join(releaseRoot, item.path);
    const relativeCheck = path.relative(releaseRoot, absolute);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) throw new Error(`manifest path escapes root: ${item.path}`);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`manifest path is not a regular file: ${item.path}`);
    const data = fs.readFileSync(absolute);
    if (data.length !== item.bytes || hash(data) !== item.sha256.toLowerCase()) {
      throw new Error(`manifest content mismatch: ${item.path}`);
    }
    declared.add(item.path);
  }

  const extractedFiles = walk(releaseRoot);
  const extras = extractedFiles.filter((file) => file !== "RELEASE-MANIFEST.json" && !declared.has(file));
  const missing = [...declared].filter((file) => !extractedFiles.includes(file));
  if (extras.length || missing.length) throw new Error(`manifest inventory mismatch: extras=${extras} missing=${missing}`);
  verifyHighConfidenceSecrets(releaseRoot, extractedFiles);

  run("npx", [
    "--yes",
    "npm@10.9.2",
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--workspace",
    "@remote-agents/shared",
    "--workspace",
    "@remote-agents/server",
  ], { cwd: releaseRoot, stdio: "inherit" });

  const username = "artifact-smoke";
  const password = `smoke-${randomBytes(24).toString("base64url")}`;
  const salt = randomBytes(16);
  const passwordHash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
  const sessionDir = path.join(temporary, "sessions");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "0",
    TRUST_PROXY: "1",
    PUBLIC_ORIGIN: "https://127.0.0.1",
    APP_USERNAME: username,
    APP_PASSWORD_HASH: passwordHash,
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    WORKER_TOKEN: randomBytes(48).toString("base64url"),
    SESSION_DIR: sessionDir,
    SESSION_DAYS: "1",
  };
  delete env.APP_PASSWORD;

  server = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: releaseRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await waitForListening(server);
  const base = `http://127.0.0.1:${port}`;

  const health = await request(`${base}/api/healthz`);
  if (health.status !== 200 || (await health.json()).ok !== true) throw new Error("packaged healthz failed");

  const unauthorized = await request(`${base}/api/health`);
  if (unauthorized.status !== 401) throw new Error(`unauthenticated API returned ${unauthorized.status}, expected 401`);

  const login = await request(`${base}/api/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://127.0.0.1",
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify({ username, password }),
  });
  if (login.status !== 200 || (await login.json()).ok !== true) throw new Error(`packaged login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie?.startsWith("ra.sid=")) throw new Error("packaged login did not issue the expected session cookie");

  const me = await request(`${base}/api/me`, { headers: { cookie } });
  if (me.status !== 200 || (await me.json()).username !== username) throw new Error("packaged authenticated API failed");

  const indexFile = path.join(releaseRoot, "apps/web/dist/index.html");
  const expectedIndex = fs.readFileSync(indexFile);
  const indexResponse = await request(`${base}/`);
  const actualIndex = Buffer.from(await indexResponse.arrayBuffer());
  if (indexResponse.status !== 200 || !actualIndex.equals(expectedIndex)) throw new Error("server did not serve packaged current web index");
  const assetMatch = expectedIndex.toString("utf8").match(/["'](\/assets\/[^"']+)["']/);
  if (!assetMatch) throw new Error("packaged web index has no versioned asset reference");
  const assetResponse = await request(`${base}${assetMatch[1]}`);
  const expectedAsset = fs.readFileSync(path.join(releaseRoot, "apps/web/dist", assetMatch[1]));
  const actualAsset = Buffer.from(await assetResponse.arrayBuffer());
  if (assetResponse.status !== 200 || !actualAsset.equals(expectedAsset)) throw new Error("server did not serve packaged current web asset");

  console.log(JSON.stringify({
    status: "PASS",
    commit: manifest.commit,
    manifestFiles: manifest.files.length,
    archiveSha256: actualArchiveHash,
    checks: [
      "checksum",
      "manifest",
      "no-secrets-or-state",
      "npm10-production-install",
      "healthz",
      "unauthenticated-api-rejection",
      "login-session",
      "current-web-index-and-asset",
    ],
  }, null, 2));
} finally {
  await stopServer(server);
  fs.rmSync(temporary, { recursive: true, force: true });
}
