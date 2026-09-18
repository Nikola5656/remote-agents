#!/usr/bin/env node
/** CI-safe preflight smoke: node version, doctor, no provider login required. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doctor = path.join(root, "scripts/doctor.mjs");

const result = spawnSync(process.execPath, [doctor, "--json"], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    SERVER_URL: process.env.SERVER_URL || "https://example.test",
    WORKER_TOKEN: process.env.WORKER_TOKEN || "smoke-token",
  },
});

if (result.status !== 0) {
  process.stderr.write(result.stdout || result.stderr || "doctor failed\n");
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout);
const hardFails = report.checks.filter((c) => c.status === "fail");
if (hardFails.length) {
  process.stderr.write(`hard failures: ${hardFails.map((c) => c.name).join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("smoke-preflight: ok\n");
