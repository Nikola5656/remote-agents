#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function rand(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function scryptHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt.toString("hex")}:${hash}`;
}

const username = process.env.APP_USERNAME || "admin";
const password = process.env.APP_PASSWORD || `Ra-${rand(12)}`;
const origin = process.env.PUBLIC_ORIGIN || "https://agents.example.com";
if (/[\r\n]/.test(username + origin) || new URL(origin).protocol !== "https:") {
  throw new Error("Use a single-line username and an HTTPS PUBLIC_ORIGIN");
}
const sessionSecret = rand(32);
const workerToken = rand(32);

const env = [
  `NODE_ENV=production`,
  `TRUST_PROXY=1`,
  `SESSION_DIR=/var/lib/remote-agents/sessions`,
  `PORT=3847`,
  `HOST=127.0.0.1`,
  `APP_USERNAME=${username}`,
  `APP_PASSWORD_HASH=${scryptHash(password)}`,
  `SESSION_SECRET=${sessionSecret}`,
  `WORKER_TOKEN=${workerToken}`,
  `PUBLIC_ORIGIN=${origin}`,
  `SESSION_DAYS=30`,
  "",
].join("\n");

const out = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "..", ".env.generated");
const credentials = `${out}.credentials.json`;
if (fs.existsSync(out) || fs.existsSync(credentials)) {
  throw new Error("Output already exists; choose a new path to avoid replacing live credentials");
}
fs.writeFileSync(out, env, { mode: 0o600, flag: "wx" });
fs.writeFileSync(credentials, JSON.stringify({ username, password }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(`wrote ${out}`);
console.log(`Login details saved to ${credentials}; store them securely, then delete that file.`);
console.log("Copy WORKER_TOKEN from the generated env file into the worker configuration. Do not commit either file.");
