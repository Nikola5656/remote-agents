import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ARTIFACTS_DIR,
  REPORTS_DIR,
  assertNoSymlinkAncestors,
  assertNoSymlinkInSourcePath,
  assertReadableInside,
  ensureDirectoryInside,
  writeFileInside,
  readBoundedFile,
} from "./path-guards";

describe("path guards", () => {
  it("rejects reads through a symlink directory ancestor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-read-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-out-"));
    fs.writeFileSync(path.join(outside, "secret.md"), "secret", "utf8");
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    assert.throws(() =>
      assertReadableInside(root, path.join("escape", "secret.md"))
    );
  });

  it("rejects writes when reports is a symlink directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-write-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-write-out-"));
    fs.symlinkSync(outside, path.join(root, REPORTS_DIR), "dir");
    assert.throws(() => writeFileInside(root, path.join(REPORTS_DIR, "leak.md"), "oops"));
    assert.equal(fs.readdirSync(outside).length, 0);
  });

  it("rejects ensureDirectoryInside when artifacts parent is a symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-artifacts-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-artifacts-out-"));
    fs.mkdirSync(path.join(root, ".remote-agents"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, ".remote-agents", "artifacts"), "dir");
    assert.throws(() => ensureDirectoryInside(root, ARTIFACTS_DIR));
    assert.equal(fs.readdirSync(outside).length, 0);
  });

  it("rejects external source paths with symlink directory ancestors", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-ext-root-"));
    const hidden = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-ext-hidden-"));
    fs.writeFileSync(path.join(hidden, "external.md"), "# x\n", "utf8");
    fs.symlinkSync(hidden, path.join(outside, "link"), "dir");
    assert.throws(() =>
      assertNoSymlinkInSourcePath(path.join(outside, "link", "external.md"))
    );
  });

  it("allows safe paths without symlinks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-guard-safe-"));
    const abs = writeFileInside(root, path.join(REPORTS_DIR, "ok.md"), "ok");
    assert.ok(fs.existsSync(abs));
    const { content } = { content: fs.readFileSync(abs, "utf8") };
    assert.equal(content, "ok");
    assertNoSymlinkAncestors(root, abs);
  });
});

it("rejects a dangling output symlink without creating its external target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-dangling-"));
  try {
    const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
    const outside = path.join(root, "outside.md");
    fs.symlinkSync(outside, path.join(workspace, "report.md"));
    assert.throws(() => writeFileInside(workspace, "report.md", "must not escape"));
    assert.equal(fs.existsSync(outside), false);
    fs.writeFileSync(outside, "0123456789");
    assert.throws(() => readBoundedFile(outside, 5));
    assert.equal(readBoundedFile(outside, 10), "0123456789");
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
