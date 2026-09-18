const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rollback = path.join(__dirname, "../deploy/rollback-server.sh");

function writeExecutable(file, text) {
  fs.writeFileSync(file, text, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function fakeCommands(root) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "is-active" ]; then
  restart_count=0
  if [ -f "$RESTART_MARKER" ]; then read -r restart_count < "$RESTART_MARKER"; fi
  if [ -f "\${RESTART_MARKER}.failed" ]; then exit 3; fi
  if [ "\${FAIL_AFTER_RESTART:-0}" = "1" ] && [ "$restart_count" -eq 1 ]; then exit 3; fi
  if [ "$restart_count" -gt 0 ]; then exit 0; fi
  exit "\${FAKE_ACTIVE_STATUS:-0}"
fi
if [ "$1" = "restart" ] && [ -n "\${RESTART_MARKER:-}" ]; then
  restart_count=0
  if [ -f "$RESTART_MARKER" ]; then read -r restart_count < "$RESTART_MARKER"; fi
  restart_count=$((restart_count + 1))
  printf '%s\\n' "$restart_count" > "$RESTART_MARKER"
  if [ "\${FAIL_RECOVERY_RESTART:-0}" = "1" ] && [ "$restart_count" -gt 1 ]; then
    : > "\${RESTART_MARKER}.failed"
    exit 1
  fi
fi
if [ "$1" = "reload" ] && [ "$2" = "nginx" ] && [ "\${FAIL_NGINX_RELOAD:-0}" = "1" ]; then exit 1; fi
exit 0
`);
  writeExecutable(path.join(bin, "nginx"), `#!/bin/sh
printf '%s\\n' "$*" >> "$NGINX_LOG"
exit 0
`);
  return bin;
}

function installedTree(parent, base, marker, options = {}) {
  const root = path.join(parent, base);
  fs.mkdirSync(path.join(root, "apps/server/dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".env"), `PRIVATE=${marker}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "apps/server/dist/index.js"), `// ${marker}\n`);
  fs.writeFileSync(path.join(root, "marker.txt"), `${marker}\n`);
  if (options.escapingSymlink) {
    fs.symlinkSync("../../outside", path.join(root, "escaping-link"));
  }
  if (options.internalLinks) {
    fs.mkdirSync(path.join(root, "packages/shared"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/shared/index.js"), "// shared\n");
    fs.mkdirSync(path.join(root, "node_modules/@remote-agents"), { recursive: true });
    fs.symlinkSync(
      "../../packages/shared",
      path.join(root, "node_modules/@remote-agents/shared")
    );
    fs.mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules/tool"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/tool/bin.js"), "// tool\n");
    fs.symlinkSync("../tool/bin.js", path.join(root, "node_modules/.bin/tool"));
    fs.linkSync(path.join(root, "marker.txt"), path.join(root, "marker-hardlink.txt"));
  }
  return root;
}

function archiveTree(sourceParent, base, archive) {
  const run = spawnSync("tar", ["-czf", archive, "-C", sourceParent, base], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
}

function runRollback({
  backup,
  dest,
  bin,
  log,
  nginxLog,
  service = "isolated-rollback.service",
  skipNginx = "1",
  extraEnv = {},
}) {
  return spawnSync("bash", [rollback, backup], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: log,
      NGINX_LOG: nginxLog,
      FAKE_ACTIVE_STATUS: "0",
      RESTART_MARKER: `${log}.restart`,
      REMOTE_AGENTS_INSTALL_DIR: dest,
      REMOTE_AGENTS_SERVICE_NAME: service,
      RA_SKIP_NGINX: skipNginx,
      RA_POST_RESTART_VERIFY_SECONDS: "1",
      ...extraEnv,
    },
  });
}

function assertUntouched(dest, log) {
  assert.equal(fs.readFileSync(path.join(dest, "marker.txt"), "utf8"), "old\n");
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", "");
  const parent = path.dirname(dest);
  const base = path.basename(dest);
  assert.deepEqual(
    fs.readdirSync(parent).filter((name) => name.startsWith(`${base}.pre-rollback.`)),
    []
  );
}

test("corrupt, traversal, and escaping-link backups leave tree and service untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-rollback-bad-"));
  try {
    const bin = fakeCommands(root);
    const cases = [];

    const corrupt = path.join(root, "corrupt.tgz");
    fs.writeFileSync(corrupt, "not a tar archive");
    cases.push(["corrupt", corrupt]);

    const traversal = path.join(root, "traversal.tgz");
    const traversalRun = spawnSync("python3", ["-c", `
import io, tarfile
with tarfile.open(${JSON.stringify(traversal)}, "w:gz") as tf:
    info = tarfile.TarInfo("install/../escape")
    data = b"escape"
    info.size = len(data)
    tf.addfile(info, io.BytesIO(data))
`], { encoding: "utf8" });
    assert.equal(traversalRun.status, 0, traversalRun.stderr);
    cases.push(["traversal", traversal]);

    const symlinkParent = path.join(root, "symlink-source");
    fs.mkdirSync(symlinkParent);
    installedTree(symlinkParent, "install", "new", { escapingSymlink: true });
    const symlink = path.join(root, "symlink.tgz");
    archiveTree(symlinkParent, "install", symlink);
    cases.push(["symlink", symlink]);

    const linkedAncestor = path.join(root, "linked-ancestor.tgz");
    const linkedAncestorRun = spawnSync("python3", ["-c", `
import io, tarfile
with tarfile.open(${JSON.stringify(linkedAncestor)}, "w:gz") as tf:
    for name in ("install", "install/apps", "install/apps/server", "install/apps/server/dist", "install/node_modules"):
        info = tarfile.TarInfo(name)
        info.type = tarfile.DIRTYPE
        tf.addfile(info)
    for name, data in (("install/.env", b"PRIVATE=new\\n"), ("install/apps/server/dist/index.js", b"// new\\n")):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    link = tarfile.TarInfo("install/alias")
    link.type = tarfile.SYMTYPE
    link.linkname = "node_modules"
    tf.addfile(link)
    payload = b"must not traverse link"
    info = tarfile.TarInfo("install/alias/payload")
    info.size = len(payload)
    tf.addfile(info, io.BytesIO(payload))
`], { encoding: "utf8" });
    assert.equal(linkedAncestorRun.status, 0, linkedAncestorRun.stderr);
    cases.push(["linked-ancestor", linkedAncestor]);

    for (const [name, backup] of cases) {
      const caseRoot = path.join(root, name);
      fs.mkdirSync(caseRoot);
      const dest = installedTree(caseRoot, "install", "old");
      const log = path.join(caseRoot, "systemctl.log");
      const result = runRollback({
        backup,
        dest,
        bin,
        log,
        nginxLog: path.join(caseRoot, "nginx.log"),
      });
      assert.notEqual(result.status, 0, `${name} unexpectedly passed: ${result.stdout}`);
      assertUntouched(dest, log);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("valid private backup restores atomically and selects the configured unit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-rollback-valid-"));
  try {
    const bin = fakeCommands(root);
    const liveParent = path.join(root, "live parent");
    const sourceParent = path.join(root, "backup source");
    fs.mkdirSync(liveParent);
    fs.mkdirSync(sourceParent);
    const dest = installedTree(liveParent, "isolated-install", "old");
    const source = installedTree(sourceParent, "isolated-install", "new", {
      internalLinks: true,
    });
    fs.chmodSync(path.join(source, ".env"), 0o640);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      fs.chownSync(path.join(source, ".env"), 65534, 65534);
    }
    const archivedEnvOwner = fs.statSync(path.join(source, ".env"));
    const backup = path.join(root, "private-backup.tgz");
    archiveTree(sourceParent, "isolated-install", backup);
    const log = path.join(root, "systemctl.log");
    const nginxLog = path.join(root, "nginx.log");

    const result = runRollback({
      backup,
      dest,
      bin,
      log,
      nginxLog,
      service: "acceptance-rollback.service",
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.readFileSync(path.join(dest, "marker.txt"), "utf8"), "new\n");
    assert.equal(fs.readFileSync(path.join(dest, ".env"), "utf8"), "PRIVATE=new\n");
    assert.equal(
      fs.readlinkSync(path.join(dest, "node_modules/@remote-agents/shared")),
      "../../packages/shared"
    );
    assert.equal(
      fs.readFileSync(path.join(dest, "node_modules/.bin/tool"), "utf8"),
      "// tool\n"
    );
    assert.equal(
      fs.statSync(path.join(dest, "marker.txt")).ino,
      fs.statSync(path.join(dest, "marker-hardlink.txt")).ino
    );
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(dest, ".env")).mode & 0o777, 0o640);
    }
    assert.equal(fs.statSync(path.join(dest, ".env")).uid, archivedEnvOwner.uid);
    assert.equal(fs.statSync(path.join(dest, ".env")).gid, archivedEnvOwner.gid);

    const displaced = fs.readdirSync(liveParent).filter((name) =>
      name.startsWith("isolated-install.pre-rollback.")
    );
    assert.equal(displaced.length, 1);
    assert.equal(
      fs.readFileSync(path.join(liveParent, displaced[0], "marker.txt"), "utf8"),
      "old\n"
    );
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
      "is-active --quiet acceptance-rollback.service",
      "stop acceptance-rollback.service",
      "daemon-reload",
      "restart acceptance-rollback.service",
      "is-active --quiet acceptance-rollback.service",
    ]);
    assert.ok(!fs.readFileSync(log, "utf8").includes("remote-agents"));
    assert.equal(fs.existsSync(nginxLog), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed or inactive unit is started and verified after a successful restore", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-rollback-inactive-"));
  try {
    const bin = fakeCommands(root);
    const liveParent = path.join(root, "live");
    const sourceParent = path.join(root, "source");
    fs.mkdirSync(liveParent);
    fs.mkdirSync(sourceParent);
    const dest = installedTree(liveParent, "install", "broken");
    installedTree(sourceParent, "install", "restored", { internalLinks: true });
    const backup = path.join(root, "backup.tgz");
    archiveTree(sourceParent, "install", backup);
    const log = path.join(root, "systemctl.log");

    const result = runRollback({
      backup,
      dest,
      bin,
      log,
      nginxLog: path.join(root, "nginx.log"),
      service: "failed-before-rollback.service",
      extraEnv: { FAKE_ACTIVE_STATUS: "3" },
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.readFileSync(path.join(dest, "marker.txt"), "utf8"), "restored\n");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
      "is-active --quiet failed-before-rollback.service",
      "daemon-reload",
      "restart failed-before-rollback.service",
      "is-active --quiet failed-before-rollback.service",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a service that exits after restart rolls back to the prior private tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-rollback-health-"));
  try {
    const bin = fakeCommands(root);
    const liveParent = path.join(root, "live");
    const sourceParent = path.join(root, "source");
    fs.mkdirSync(liveParent);
    fs.mkdirSync(sourceParent);
    const dest = installedTree(liveParent, "install", "old");
    installedTree(sourceParent, "install", "new", { internalLinks: true });
    const backup = path.join(root, "backup.tgz");
    archiveTree(sourceParent, "install", backup);
    const log = path.join(root, "systemctl.log");

    const result = runRollback({
      backup,
      dest,
      bin,
      log,
      nginxLog: path.join(root, "nginx.log"),
      service: "delayed-failure.service",
      extraEnv: { FAIL_AFTER_RESTART: "1" },
    });

    assert.notEqual(result.status, 0, "delayed service failure unexpectedly passed");
    assert.equal(fs.readFileSync(path.join(dest, "marker.txt"), "utf8"), "old\n");
    const failed = fs.readdirSync(liveParent).filter((name) =>
      name.startsWith("install.failed-rollback.")
    );
    assert.equal(failed.length, 1);
    assert.equal(fs.readFileSync(path.join(liveParent, failed[0], "marker.txt"), "utf8"), "new\n");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
      "is-active --quiet delayed-failure.service",
      "stop delayed-failure.service",
      "daemon-reload",
      "restart delayed-failure.service",
      "is-active --quiet delayed-failure.service",
      "daemon-reload",
      "restart delayed-failure.service",
      "is-active --quiet delayed-failure.service",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nginx reload failure keeps the healthy restored application committed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-rollback-nginx-"));
  try {
    const bin = fakeCommands(root);
    const liveParent = path.join(root, "live");
    const sourceParent = path.join(root, "source");
    fs.mkdirSync(liveParent);
    fs.mkdirSync(sourceParent);
    const dest = installedTree(liveParent, "install", "old");
    installedTree(sourceParent, "install", "new", { internalLinks: true });
    const backup = path.join(root, "backup.tgz");
    archiveTree(sourceParent, "install", backup);
    const log = path.join(root, "systemctl.log");
    const nginxLog = path.join(root, "nginx.log");

    const result = runRollback({
      backup,
      dest,
      bin,
      log,
      nginxLog,
      service: "nginx-boundary.service",
      skipNginx: "0",
      extraEnv: { FAIL_NGINX_RELOAD: "1" },
    });

    assert.notEqual(result.status, 0, "nginx reload failure unexpectedly passed");
    assert.match(result.stderr, /nginx reload failed; restored application remains active/);
    assert.doesNotMatch(result.stderr, /previous install restored/);
    assert.equal(fs.readFileSync(path.join(dest, "marker.txt"), "utf8"), "new\n");
    const displaced = fs.readdirSync(liveParent).filter((name) =>
      name.startsWith("install.pre-rollback.")
    );
    assert.equal(displaced.length, 1);
    assert.equal(fs.readFileSync(path.join(liveParent, displaced[0], "marker.txt"), "utf8"), "old\n");
    assert.deepEqual(
      fs.readdirSync(liveParent).filter((name) => name.startsWith("install.failed-rollback.")),
      []
    );
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
      "is-active --quiet nginx-boundary.service",
      "stop nginx-boundary.service",
      "daemon-reload",
      "restart nginx-boundary.service",
      "is-active --quiet nginx-boundary.service",
      "reload nginx",
    ]);
    assert.equal(fs.readFileSync(nginxLog, "utf8"), "-t\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery restart failure is explicit and reports the resulting service state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-rollback-recovery-failure-"));
  try {
    const bin = fakeCommands(root);
    const liveParent = path.join(root, "live");
    const sourceParent = path.join(root, "source");
    fs.mkdirSync(liveParent);
    fs.mkdirSync(sourceParent);
    const dest = installedTree(liveParent, "install", "old");
    installedTree(sourceParent, "install", "new", { internalLinks: true });
    const backup = path.join(root, "backup.tgz");
    archiveTree(sourceParent, "install", backup);
    const log = path.join(root, "systemctl.log");

    const result = runRollback({
      backup,
      dest,
      bin,
      log,
      nginxLog: path.join(root, "nginx.log"),
      service: "recovery-failure.service",
      extraEnv: { FAIL_AFTER_RESTART: "1", FAIL_RECOVERY_RESTART: "1" },
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(dest, "marker.txt"), "utf8"), "old\n");
    assert.match(result.stderr, /recovery failed to restart previous service recovery-failure\.service/);
    assert.match(result.stderr, /service state after recovery: not active \(restart failed\)/);
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
      "is-active --quiet recovery-failure.service",
      "stop recovery-failure.service",
      "daemon-reload",
      "restart recovery-failure.service",
      "is-active --quiet recovery-failure.service",
      "daemon-reload",
      "restart recovery-failure.service",
      "is-active --quiet recovery-failure.service",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
