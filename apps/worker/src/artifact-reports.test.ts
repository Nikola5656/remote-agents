import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ARTIFACTS_DIR,
  MAX_PRODUCED_PATHS,
  REPORT_TASK_MARKER,
  assertNoSymlinkAncestors,
  buildTranscriptReportContent,
  createRunReportPath,
  copyExternalMarkdownToArtifacts,
  extractMarkdownLinks,
  extractWritePathsFromEvent,
  finalizeRunReports,
  materializeTranscriptReport,
  reportHintsEnabled,
  withReportInstruction,
} from "./artifact-reports";

const prevDisableHints = process.env.REMOTE_AGENTS_DISABLE_REPORT_HINTS;

beforeEach(() => {
  delete process.env.REMOTE_AGENTS_DISABLE_REPORT_HINTS;
});

afterEach(() => {
  process.env.REMOTE_AGENTS_DISABLE_REPORT_HINTS = prevDisableHints;
});

describe("artifact reports", () => {
  it("adds the report instruction once by default", () => {
    assert.ok(reportHintsEnabled());
    assert.ok(withReportInstruction("do work").includes(REPORT_TASK_MARKER));
    assert.equal(withReportInstruction("do work"), withReportInstruction(withReportInstruction("do work")));
  });

  it("can disable report hints for tests", () => {
    process.env.REMOTE_AGENTS_DISABLE_REPORT_HINTS = "1";
    assert.equal(reportHintsEnabled(), false);
    assert.equal(withReportInstruction("plain"), "plain");
  });

  it("extracts completed write paths from tool events", () => {
    const paths = extractWritePathsFromEvent({
      type: "tool_call",
      subtype: "completed",
      tool_call: {
        writeToolCall: { args: { path: "/tmp/outside/report.md" } },
      },
    });
    assert.deepEqual(paths, ["/tmp/outside/report.md"]);
  });

  it("does not count a read or failed tool as a produced document", () => {
    assert.deepEqual(extractWritePathsFromEvent({ type: "tool_call", subtype: "completed", tool_call: { readToolCall: { args: { path: "reports/existing.md" } } } }), []);
    assert.deepEqual(extractWritePathsFromEvent({ type: "tool_call", subtype: "completed", is_error: true, tool_call: { writeToolCall: { args: { path: "reports/failed.md" } } } }), []);
  });

  it("extracts markdown links from assistant text", () => {
    const links = extractMarkdownLinks("See [notes](./reports/notes.md) and also summary.md");
    assert.ok(links.includes("./reports/notes.md"));
    assert.ok(links.includes("summary.md"));
  });

  it("extracts external markdown paths with spaces, unicode, parentheses, and angle brackets", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-edge-src-"));
    const spaced = path.join(outside, "my report.md");
    const unicode = path.join(outside, "raport-čćž.md");
    const paren = path.join(outside, "note (draft).md");
    const angled = path.join(outside, "angle file.md");
    for (const file of [spaced, unicode, paren, angled]) fs.writeFileSync(file, "# ok\n");

    const spacedLinks = extractMarkdownLinks(`See [r](${spaced})`);
    const unicodeLinks = extractMarkdownLinks(`See [r](${unicode})`);
    const parenLinks = extractMarkdownLinks(`See [r](${paren})`);
    const angleLinks = extractMarkdownLinks(`See [r](<${angled}>)`);
    assert.ok(spacedLinks.includes(spaced));
    assert.ok(unicodeLinks.includes(unicode));
    assert.ok(parenLinks.includes(paren));
    assert.ok(angleLinks.includes(angled));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-edge-ws-"));
    const result = finalizeRunReports({
      workspaceRoot: root,
      status: "finished",
      transcript: `See [p](${paren}) and [a](<${angled}>)`,
      headline: "Done",
      userPrompt: "edge",
      producedPaths: [],
    });
    assert.equal(result.artifactCopies.length, 2);
  });

  it("still rejects oversize and symlink-ancestor external copies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-edge-neg-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-edge-neg-out-"));
    const huge = path.join(outside, "huge.md");
    fs.writeFileSync(huge, "x".repeat(512 * 1024 + 1));
    assert.equal(copyExternalMarkdownToArtifacts(root, huge), null);

    const hidden = fs.mkdtempSync(path.join(os.tmpdir(), "ra-edge-neg-hid-"));
    fs.writeFileSync(path.join(hidden, "secret.md"), "# secret\n");
    fs.symlinkSync(hidden, path.join(outside, "link"), "dir");
    assert.equal(copyExternalMarkdownToArtifacts(root, path.join(outside, "link", "secret.md")), null);
    assert.equal(fs.existsSync(path.join(root, ARTIFACTS_DIR)), false);
  });

  it("materializes a transcript report for finished runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-report-"));
    const rel = materializeTranscriptReport({
      workspaceRoot: root,
      runId: "run-123",
      status: "finished",
      transcript: "x".repeat(120),
      headline: "Done",
      userPrompt: "analyze",
    });
    assert.ok(rel);
    const content = fs.readFileSync(path.join(root, rel!), "utf8");
    assert.match(content, /auto-generated/);
    assert.match(content, /not a separately authored document/);
    assert.match(content, /analyze/);
  });

  it("materializes short finished transcripts instead of skipping them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-report-short-"));
    const rel = materializeTranscriptReport({
      workspaceRoot: root,
      status: "finished",
      transcript: "ok",
      headline: "Done",
      userPrompt: "hi",
    });
    assert.ok(rel);
    const content = fs.readFileSync(path.join(root, rel!), "utf8");
    assert.match(content, /ok/);
  });

  it("materializes error reports from headline when transcript is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-report-err-"));
    const rel = materializeTranscriptReport({
      workspaceRoot: root,
      status: "error",
      transcript: "",
      headline: "Boom",
      userPrompt: "hi",
    });
    assert.ok(rel);
    assert.match(buildTranscriptReportContent({
      status: "error",
      transcript: "",
      headline: "Boom",
      userPrompt: "hi",
    }), /ended with an error/);
  });

  it("copies external markdown into the artifact directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-artifact-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-outside-"));
    const source = path.join(outside, "external.md");
    fs.writeFileSync(source, "# outside\n", "utf8");
    const copied = copyExternalMarkdownToArtifacts(root, source);
    assert.ok(copied);
    assert.ok(copied!.startsWith(`${ARTIFACTS_DIR.replace(/\\/g, "/")}/`));
    assert.ok(fs.existsSync(path.join(root, copied!)));
  });

  it("does not copy external markdown through symlink source ancestors", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-artifact-src-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-outside-src-"));
    const hidden = fs.mkdtempSync(path.join(os.tmpdir(), "ra-hidden-src-"));
    fs.writeFileSync(path.join(hidden, "external.md"), "# outside\n", "utf8");
    fs.symlinkSync(hidden, path.join(outside, "link"), "dir");
    const copied = copyExternalMarkdownToArtifacts(root, path.join(outside, "link", "external.md"));
    assert.equal(copied, null);
    assert.equal(fs.existsSync(path.join(root, ARTIFACTS_DIR)), false);
  });

  it("does not write reports through a symlink reports directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-report-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-report-out-"));
    fs.symlinkSync(outside, path.join(root, "reports"), "dir");
    assert.throws(() =>
      materializeTranscriptReport({
        workspaceRoot: root,
        status: "finished",
        transcript: "done",
        headline: "Done",
        userPrompt: "work",
      })
    );
    assert.equal(fs.readdirSync(outside).length, 0);
  });

  it("does not copy artifacts through a symlink artifacts directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-artifact-dest-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-outside-dest-"));
    const leak = fs.mkdtempSync(path.join(os.tmpdir(), "ra-leak-dest-"));
    const source = path.join(outside, "external.md");
    fs.writeFileSync(source, "# outside\n", "utf8");
    fs.mkdirSync(path.join(root, ".remote-agents"), { recursive: true });
    fs.symlinkSync(leak, path.join(root, ".remote-agents", "artifacts"), "dir");
    const copied = copyExternalMarkdownToArtifacts(root, source);
    assert.equal(copied, null);
    assert.equal(fs.readdirSync(leak).length, 0);
  });

  it("rejects symlink ancestors when resolving produced workspace markdown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-outside-"));
    const secret = path.join(outside, "secret.md");
    fs.writeFileSync(secret, "# secret\n", "utf8");
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    assert.throws(() => assertNoSymlinkAncestors(root, path.join(root, "escape", "secret.md")));
    const result = finalizeRunReports({
      workspaceRoot: root,
      status: "finished",
      transcript: "done",
      headline: "Done",
      userPrompt: "work",
      producedPaths: [path.join(root, "escape", "secret.md")],
    });
    assert.equal(result.workspaceMarkdown.length, 0);
    assert.ok(result.defaultReportPath);
  });

  it("does not treat stale markdown links as produced workspace reports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-stale-link-"));
    fs.mkdirSync(path.join(root, "reports"), { recursive: true });
    fs.writeFileSync(path.join(root, "reports", "old.md"), "# old\n", "utf8");
    const result = finalizeRunReports({
      workspaceRoot: root,
      status: "finished",
      transcript: "See [old](./reports/old.md) for context.",
      headline: "Done",
      userPrompt: "work",
      producedPaths: [],
    });
    assert.equal(result.workspaceMarkdown.length, 0);
    assert.ok(result.defaultReportPath);
  });

  it("publishes an external report linked by the final answer without a typed write event", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ra-linked-"));
    try {
      const root = path.join(temp, "workspace"); fs.mkdirSync(root);
      const source = path.join(temp, "outside.md"); fs.writeFileSync(source, "# verified");
      const result = finalizeRunReports({workspaceRoot: root, status: "finished", transcript: `Done: [report](${source})`, headline: "Done", userPrompt: "review", producedPaths: []});
      assert.equal(result.artifactCopies.length, 1);
      assert.equal(result.defaultReportPath, null);
      assert.equal(fs.readFileSync(path.join(root, result.artifactCopies[0]), "utf8"), "# verified");
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }
  });

  it("bounds produced path processing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-bound-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ra-outside-bound-"));
    const produced = Array.from({ length: MAX_PRODUCED_PATHS + 5 }, (_, i) => {
      const file = path.join(outside, `file-${i}.md`);
      fs.writeFileSync(file, `# ${i}\n`, "utf8");
      return file;
    });
    const result = finalizeRunReports({
      workspaceRoot: root,
      status: "finished",
      transcript: "done",
      headline: "Done",
      userPrompt: "work",
      producedPaths: produced,
    });
    assert.equal(result.artifactCopies.length, MAX_PRODUCED_PATHS);
  });

  it("finalizes with a default report when no workspace markdown was produced", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-finalize-"));
    const result = finalizeRunReports({
      workspaceRoot: root,
      status: "finished",
      transcript: "assistant ".repeat(20),
      headline: "Done",
      userPrompt: "work",
      producedPaths: [],
    });
    assert.ok(result.defaultReportPath);
    assert.equal(result.workspaceMarkdown.length, 0);
  });

  it("prefers agent-authored workspace markdown over a default report", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-finalize-"));
    fs.mkdirSync(path.join(root, "reports"), { recursive: true });
    const authored = path.join(root, "reports", "agent.md");
    fs.writeFileSync(authored, "# real report\n", "utf8");
    const result = finalizeRunReports({
      workspaceRoot: root,
      status: "finished",
      transcript: "assistant ".repeat(20),
      headline: "Done",
      userPrompt: "work",
      producedPaths: [authored],
    });
    assert.equal(result.defaultReportPath, null);
    assert.deepEqual(result.workspaceMarkdown, ["reports/agent.md"]);
  });
});


describe("run-owned report destinations", () => {
  it("does not mistake another slot's fresh report for this run's output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-report-provenance-"));
    try {
      fs.mkdirSync(path.join(root, "reports"));
      fs.writeFileSync(path.join(root, "reports", "another-agent.md"), "# Fresh unrelated report");
      const result = finalizeRunReports({ workspaceRoot: root, status: "finished", transcript: "Done", headline: "Done", userPrompt: "Review document navigation", producedPaths: [], requestedReportPath: createRunReportPath("Review document navigation") });
      assert.ok(result.defaultReportPath);
      assert.match(result.defaultReportPath, /^reports\/session-review-document-navigation-/);
      assert.deepEqual(result.workspaceMarkdown, []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses bounded descriptive names, unique destinations, and generic names for sensitive prompts", () => {
    const prompt = "Review the mobile documents interface and validate all the important scenarios carefully";
    const first = createRunReportPath(prompt);
    const second = createRunReportPath(prompt);
    assert.notEqual(first, second);
    assert.match(first, /^reports\/report-review-the-mobile-documents-interface-and-/);
    assert.ok(path.basename(first).length <= 100);
    for (const sensitive of ["Use password secret-value", "Read /private/workspace/report.md", "Open https://example.test", "", "Use API_KEY=abc123"]) {
      assert.match(createRunReportPath(sensitive), /^reports\/report-\d{4}-/);
    }
  });
});
