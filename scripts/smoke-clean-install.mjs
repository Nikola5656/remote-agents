#!/usr/bin/env node
/**
 * Clean-install smoke for CI: npm ci, build, test, doctor (non-strict).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, cmd, args, env = {}) {
  process.stdout.write(`==> ${label}\n`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm ci", "npm", ["ci", "--no-audit", "--no-fund"]);
run("npm build", "npm", ["run", "build"]);
run("npm test", "npm", ["test"]);
run("doctor", process.execPath, [
  path.join(root, "scripts/doctor.mjs"),
  "--json",
], {
  SERVER_URL: "https://example.test",
  WORKER_TOKEN: "ci-smoke-token",
});
process.stdout.write("smoke-clean-install: ok\n");
