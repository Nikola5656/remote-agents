import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ARTIFACTS_DIR } from "./path-guards";
import {
  listArtifactMarkdown,
  listWorkspaceMarkdown,
  listMarkdownFiles,
  readMarkdownFile,
  resolveInside,
} from "./workspace-files";

describe("workspace files", () => {
  it("lists markdown inside the workspace only", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-md-"));
    fs.writeFileSync(path.join(root, "README.md"), "# hi\n");
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "note.md"), "note");
    fs.writeFileSync(path.join(root, "skip.txt"), "no");
    const listed = listMarkdownFiles(root).map((f) => f.path);
    assert.equal(listed.length, 2);
    assert.ok(listed.includes("README.md"));
    assert.ok(listed.includes("docs/note.md"));
  });

  it("lists copied artifact markdown under .remote-agents/artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-md-artifact-"));
    const artifactDir = path.join(root, ARTIFACTS_DIR);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "copied.md"), "# copied\n", "utf8");
    const listed = listMarkdownFiles(root).map((f) => f.path);
    assert.ok(listed.includes(".remote-agents/artifacts/copied.md"));
  });

  it("does not list markdown through a symlink artifacts directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-md-artifact-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-md-artifact-out-"));
    fs.mkdirSync(path.join(root, ".remote-agents"), { recursive: true });
    fs.writeFileSync(path.join(outside, "leaked.md"), "# leaked\n", "utf8");
    fs.symlinkSync(outside, path.join(root, ".remote-agents", "artifacts"), "dir");
    assert.deepEqual(listArtifactMarkdown(root), []);
    assert.deepEqual(listMarkdownFiles(root), []);
  });

  it("rejects reads through a symlink directory ancestor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-md-read-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-md-read-out-"));
    fs.writeFileSync(path.join(outside, "secret.md"), "secret", "utf8");
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    assert.throws(() => readMarkdownFile(root, path.join("escape", "secret.md")));
  });

  it("rejects path escape, non-markdown, symlinks, and oversize files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-md-"));
    fs.writeFileSync(path.join(root, "ok.md"), "ok");
    assert.throws(() => resolveInside(root, "../secret.md"));
    assert.throws(() => readMarkdownFile(root, "ok.txt"));

    const target = path.join(root, "real.md");
    fs.writeFileSync(target, "real");
    const link = path.join(root, "link.md");
    fs.symlinkSync(target, link);
    assert.throws(() => readMarkdownFile(root, "link.md"));

    const huge = path.join(root, "huge.md");
    fs.writeFileSync(huge, "x".repeat(512 * 1024 + 1));
    assert.throws(() => readMarkdownFile(root, "huge.md"));

    const file = readMarkdownFile(root, "ok.md");
    assert.equal(file.content, "ok");
  });
});


describe("bounded report discovery", () => {
  it("finds fresh root reports and top-level files before crowded earlier projects", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-crowded-reports-"));
    try {
      const project = path.join(root, "aaa-project", "nested");
      fs.mkdirSync(project, { recursive: true });
      for (let i = 0; i < 240; i++) fs.writeFileSync(path.join(project, `old-${i}.md`), "old");
      fs.mkdirSync(path.join(root, "reports"));
      fs.writeFileSync(path.join(root, "reports", "REQUIREMENTS_STATUS_REPORT.md"), "fresh report");
      fs.writeFileSync(path.join(root, "ZZ_TOP_LEVEL.md"), "top level");
      for (const listed of [listWorkspaceMarkdown(root), listMarkdownFiles(root)]) {
        const paths = listed.map(f => f.path);
        assert.ok(paths.includes("reports/REQUIREMENTS_STATUS_REPORT.md"));
        assert.ok(paths.includes("ZZ_TOP_LEVEL.md"));
        assert.equal(paths.length, 200);
        assert.equal(new Set(paths).size, paths.length);
      }
      const discovered = listWorkspaceMarkdown(root).map(f => f.path);
      assert.equal(discovered[0], "reports/REQUIREMENTS_STATUS_REPORT.md");
      assert.equal(discovered[1], "ZZ_TOP_LEVEL.md");
      assert.equal(readMarkdownFile(root, discovered[0]).content, "fresh report");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps priority discovery inside symlink and 512KB boundaries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-priority-safe-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-priority-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "outside");
      fs.symlinkSync(outside, path.join(root, "reports"), "dir");
      fs.writeFileSync(path.join(root, "safe.md"), "safe");
      assert.deepEqual(listWorkspaceMarkdown(root).map(f => f.path), ["safe.md"]);
      fs.unlinkSync(path.join(root, "reports"));
      fs.mkdirSync(path.join(root, "reports"));
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "reports", "link.md"));
      fs.writeFileSync(path.join(root, "reports", "huge.md"), "x".repeat(512 * 1024 + 1));
      fs.writeFileSync(path.join(root, "reports", "limit.md"), "x".repeat(512 * 1024));
      assert.deepEqual(listWorkspaceMarkdown(root).map(f => f.path), ["reports/limit.md", "safe.md"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("bounds deep traversal without losing shallow reports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-depth-budget-"));
    try {
      fs.mkdirSync(path.join(root, "reports"));
      fs.writeFileSync(path.join(root, "reports", "status.md"), "status");
      let deep = root;
      for (let i = 0; i < 12; i++) { deep = path.join(deep, "nested"); fs.mkdirSync(deep); }
      fs.writeFileSync(path.join(deep, "too-deep.md"), "deep");
      assert.deepEqual(listWorkspaceMarkdown(root).map(f => f.path), ["reports/status.md"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});


describe("relevant document selection", () => {
  it("retains new reports after more than 200 historical reports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-report-history-"));
    try {
      fs.mkdirSync(path.join(root, "reports"));
      for (let i = 0; i < 240; i++) {
        const file = path.join(root, "reports", `old-${String(i).padStart(3, "0")}.md`);
        fs.writeFileSync(file, "old");
        fs.utimesSync(file, 1000, 1000);
      }
      fs.writeFileSync(path.join(root, "reports", "zzz-latest.md"), "current outcome");
      for (const files of [listWorkspaceMarkdown(root), listMarkdownFiles(root)]) {
        assert.equal(files.length, 200);
        assert.equal(files[0].path, "reports/zzz-latest.md");
        assert.equal(readMarkdownFile(root, files[0].path).content, "current outcome");
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("bounds artifact results and keeps recent copied reports ahead of project context", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-artifact-history-"));
    try {
      fs.mkdirSync(path.join(root, ARTIFACTS_DIR), { recursive: true });
      for (let i = 0; i < 220; i++) {
        const file = path.join(root, ARTIFACTS_DIR, `old-${String(i).padStart(3, "0")}.md`);
        fs.writeFileSync(file, "old");
        fs.utimesSync(file, 1000, 1000);
      }
      const latest = path.join(root, ARTIFACTS_DIR, "zzz-latest.md");
      fs.writeFileSync(latest, "latest copied report");
      fs.utimesSync(latest, 2000, 2000);
      fs.writeFileSync(path.join(root, "README.md"), "newer context");
      const artifacts = listArtifactMarkdown(root);
      assert.equal(artifacts.length, 200);
      assert.equal(artifacts[0].path, ".remote-agents/artifacts/zzz-latest.md");
      const listed = listMarkdownFiles(root);
      assert.equal(listed.length, 200);
      assert.equal(listed[0].path, artifacts[0].path);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
