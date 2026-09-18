const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const launcher = path.join(__dirname, "run-fresh-runtime-e2e.sh");

test("packaged Linux runtime E2E (server boot, worker WS, login, markdown, restart)", { timeout: 600_000 }, (t) => {
  const run = spawnSync("bash", [launcher], { encoding: "utf8", env: process.env });
  if (run.status !== 0 && /docker.*not found|Cannot connect to the Docker daemon/i.test(run.stderr + run.stdout)) {
    t.skip("Docker unavailable");
    return;
  }
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  assert.match(run.stdout, /"status": "PASS"/);
  assert.match(run.stdout, /restart-persistence/);
});
