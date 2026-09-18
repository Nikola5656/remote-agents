#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(process.env.RELEASE_OUTPUT_DIR || path.join(root, "release"));
const commit = (process.env.CI_COMMIT_SHA || execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
})).trim();

if (!/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error("Release commit must be a full Git SHA");
}

const files = [
  ".env.example",
  "AGENTS.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "package.json",
  "package-lock.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "apps/worker/package.json",
  "packages/shared/package.json",
  "apps/server/public/index.html",
  "apps/worker/scripts/common-env.sh",
  "apps/worker/scripts/install-linux.sh",
  "apps/worker/scripts/install-macos.sh",
  "apps/worker/scripts/install-windows.ps1",
  "apps/worker/scripts/uninstall-linux.sh",
  "apps/worker/scripts/uninstall-macos.sh",
  "apps/worker/scripts/uninstall-windows.ps1",
  "apps/worker/scripts/worker-env.py",
  "apps/worker/scripts/systemd-serialize.py",
  "apps/worker/scripts/write-worker-env.sh",
  "config/README.md",
  "config/claude/settings.json.template",
  "config/codex/config.toml.template",
  "config/cursor/cli-defaults.md",
  "deploy/env.server.example",
  "deploy/install-lib.sh",
  "deploy/install-server.sh",
  "deploy/issue-cert.sh",
  "deploy/macos/remote-agents-worker.plist",
  "deploy/nginx/remote-agents.conf.template",
  "deploy/nginx/remote-agents.http-only.conf.template",
  "deploy/render-nginx-template.sh",
  "deploy/rollback-server.sh",
  "deploy/systemd/remote-agents.service.template",
  "deploy/uninstall-server.sh",
  "docs/setup.md",
  "examples/fleet.defaults.json",
  "examples/fleet.portable.json",
  "scripts/assert-node-version.mjs",
  "scripts/doctor.mjs",
  "scripts/gen-secrets.js",
  "scripts/setup-lib.mjs",
  "scripts/setup-worker.mjs",
  "scripts/setup-worker-wsl.ps1",
  "scripts/wsl-common.ps1",
];

const directories = [
  "apps/server/dist",
  "apps/web/dist",
  "apps/worker/dist",
  "packages/shared/dist",
];

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function copyRegularFile(relative, stageRoot, manifest) {
  const source = path.join(root, relative);
  const stat = fs.lstatSync(source);
  if (!stat.isFile()) throw new Error(`Allowlisted release entry is not a regular file: ${relative}`);
  const destination = path.join(stageRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, stat.mode & 0o777);
  const data = fs.readFileSync(source);
  manifest.push({ path: relative, bytes: data.length, sha256: sha256(data) });
}

function copyDirectory(relative, stageRoot, manifest) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`Required build output is missing: ${relative}`);
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) copyDirectory(child, stageRoot, manifest);
    else if (entry.isFile()) copyRegularFile(child, stageRoot, manifest);
    else throw new Error(`Release allowlist rejects links and special files: ${child}`);
  }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "remote-agents-release-"));
const stageRoot = path.join(temporary, "remote-agents");
const manifest = [];

try {
  fs.mkdirSync(stageRoot, { recursive: true });
  for (const file of files) copyRegularFile(file, stageRoot, manifest);
  for (const directory of directories) copyDirectory(directory, stageRoot, manifest);
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const manifestDocument = `${JSON.stringify({
    formatVersion: 1,
    commit,
    files: manifest,
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(stageRoot, "RELEASE-MANIFEST.json"), manifestDocument, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });

  fs.mkdirSync(outputDir, { recursive: true });
  const base = `remote-agents-${commit}`;
  const archive = path.join(outputDir, `${base}.tgz`);
  const checksum = `${archive}.sha256`;
  if (fs.existsSync(archive) || fs.existsSync(checksum)) {
    throw new Error(`Refusing to overwrite existing release output: ${archive}`);
  }

  const tarVersion = execFileSync("tar", ["--version"], { encoding: "utf8" });
  const tarArgs = tarVersion.includes("GNU tar")
    ? [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        archive,
        "remote-agents",
      ]
    : ["-czf", archive, "remote-agents"];
  if (!tarVersion.includes("GNU tar")) {
    console.warn("Non-GNU tar detected; archive is valid but reproducible metadata is guaranteed only in the GitLab Linux image");
  }
  execFileSync("tar", tarArgs, { cwd: temporary, stdio: "inherit" });

  const digest = sha256(fs.readFileSync(archive));
  fs.writeFileSync(checksum, `${digest}  ${path.basename(archive)}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
  console.log(`release archive: ${archive}`);
  console.log(`release checksum: ${checksum}`);
  console.log(`release files: ${manifest.length + 1}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
