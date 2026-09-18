const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const serializer = path.join(__dirname, "../apps/worker/scripts/systemd-serialize.py");
const template = path.join(__dirname, "../deploy/systemd/remote-agents.service.template");
const containerVerify = path.join(__dirname, "systemd-analyze-verify.sh");

function py(args, opts = {}) {
  return spawnSync("python3", [serializer, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    ...opts,
  });
}

test("systemd serializer quotes spaces, percent, and dollar in worker unit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra systemd "));
  try {
    const root = path.join(dir, "repo with spaces");
    const home = path.join(dir, "home $100% done");
    const unit = path.join(dir, "worker.service");
    fs.mkdirSync(root, { recursive: true });
    const run = py([
      "worker-unit",
      "--output",
      unit,
      "--root",
      root,
      "--node",
      process.execPath,
      "--worker-js",
      path.join(root, "apps/worker/dist/index.js"),
      "--env-file",
      path.join(home, "worker.env"),
      "--log-dir",
      path.join(home, "logs"),
    ]);
    assert.equal(run.status, 0, run.stderr);
    const text = fs.readFileSync(unit, "utf8");
    assert.ok(text.includes("repo\\swith\\sspaces"), text);
    assert.ok(text.includes('ExecStart='));
    assert.ok(text.includes("repo with spaces/apps/worker/dist/index.js"));
    assert.ok(text.includes("worker.env"));
    assert.ok(text.includes("StandardOutput=append:"));
    assert.ok(text.includes("logs/worker.log"));
    if (process.platform === "linux" && spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" }).status === 0) {
      const verify = spawnSync("systemd-analyze", ["verify", unit], { encoding: "utf8" });
      assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ExecStart escapes dollar signs as $$ inside quoted arguments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra execstart "));
  try {
    const root = path.join(dir, "repo $VAR");
    const unit = path.join(dir, "worker.service");
    fs.mkdirSync(root, { recursive: true });
    const run = py([
      "worker-unit",
      "--output",
      unit,
      "--root",
      root,
      "--node",
      "/usr/bin/node",
      "--worker-js",
      path.join(root, "index.js"),
      "--env-file",
      path.join(dir, "worker.env"),
      "--log-dir",
      path.join(dir, "logs"),
    ]);
    assert.equal(run.status, 0, run.stderr);
    const text = fs.readFileSync(unit, "utf8");
    assert.ok(text.includes("repo\\s$VAR"), text);
    assert.ok(text.includes('repo $$VAR/index.js"'), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server systemd template renders quoted install paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra server unit "));
  try {
    const installDir = path.join(dir, "opt", "remote agents");
    const stateDir = path.join(dir, "var", "lib", "remote agents");
    const output = path.join(dir, "remote-agents.service");
    const run = py([
      "server-unit",
      "--template",
      template,
      "--output",
      output,
      "--install-dir",
      installDir,
      "--state-dir",
      stateDir,
      "--service-user",
      "www-data",
    ]);
    assert.equal(run.status, 0, run.stderr);
    const text = fs.readFileSync(output, "utf8");
    assert.ok(text.includes("remote\\sagents"), text);
    assert.ok(text.includes("remote agents/node_modules"), text);
    assert.ok(text.includes('ExecStart=/usr/bin/node "'));
    assert.ok(text.includes("remote agents/apps/server/dist/index.js"));
    assert.ok(text.includes("remote\\sagents"));
    const bad = py(["quote", "bad\npath"]);
    assert.notEqual(bad.status, 0, bad.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rendered units pass systemd-analyze verify in Ubuntu container", { timeout: 300_000 }, (t) => {
  const run = spawnSync("bash", [containerVerify], {
    encoding: "utf8",
    env: { ...process.env, SYSTEMD_VERIFY_IMAGE: process.env.SYSTEMD_VERIFY_IMAGE || "ubuntu:24.04" },
  });
  if (run.status === 2) {
    t.skip("Docker/systemd environment unavailable; covered by dedicated Linux validation");
    return;
  }
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  assert.match(run.stdout, /systemd-analyze-verify: PASS/);
});
