import assert from "node:assert/strict";
import test from "node:test";
import { copiedArtifactCandidates, documentAppHref, documentTitle, headingAnchors, isSupportingDocument, linkedDocument, selectDocuments, workspaceDocumentPath } from "./documents.js";
const files = [
  { path: "reports/security-audit.md", bytes: 10, mtime: 10 },
  { path: "tests/fixtures/report.md", bytes: 10, mtime: 40 },
  { path: "AGENTS.md", bytes: 10, mtime: 30 },
  { path: "reports/release-validation.md", bytes: 10, mtime: 20 },
];

test("default document list hides fixtures and agent instructions while retaining real reports", () => {
  assert.deepEqual(selectDocuments(files, "", false, "recent").map((file) => file.path), ["reports/release-validation.md", "reports/security-audit.md"]);
  assert.equal(isSupportingDocument("docs/testing-guide.md"), false);
  assert.equal(selectDocuments(files, "", true, "recent").length, 4);
});

test("search includes supporting documents and requires all search words", () => {
  assert.deepEqual(selectDocuments(files, "fixtures report", false, "recent").map((file) => file.path), ["tests/fixtures/report.md"]);
  assert.equal(selectDocuments(files, "agents", false, "name")[0].path, "AGENTS.md");
  assert.equal(selectDocuments(files, "security missing", true, "recent").length, 0);
  assert.equal(files[0].path, "reports/security-audit.md", "sorting does not mutate API state");
});

test("Markdown document links resolve within the workspace and reject unsafe destinations", () => {
  assert.equal(linkedDocument("docs/guide.md", "../README.md#setup"), "README.md");
  assert.equal(linkedDocument("docs/guide.md", "./file%20name.md"), "docs/file name.md");
  for (const href of ["../../secret.md", "https://example.com/file.md", "file:///etc/file.md", "javascript:evil.md", "/absolute.md", "#heading", "bad%ZZ.md", "..\\secret.md"]) {
    assert.equal(linkedDocument("docs/guide.md", href), null, href);
  }
});

test("recommended ordering prioritizes deliverables without changing newest-first sorting", () => {
  const mixed = [...files, { path: "README.md", bytes: 1, mtime: 100 }, { path: "docs/overview.md", bytes: 1, mtime: 200 }];
  assert.equal(selectDocuments(mixed, "", false, "recommended")[0].path, "reports/release-validation.md");
  assert.equal(selectDocuments(mixed, "", false, "recent")[0].path, "docs/overview.md");
  assert.equal(isSupportingDocument("reports/E2E_agent-test.md"), true);
  assert.equal(isSupportingDocument("reports/end-to-end-validation-task-codex.md"), true);
  assert.equal(isSupportingDocument("reports/validation-findings.md"), false);
});

test("absolute agent-generated report links open within their workspace on every platform", () => {
  assert.equal(linkedDocument("", "/home/operator/project/reports/result.md", "/home/operator/project"), "reports/result.md");
  assert.equal(linkedDocument("reports/old.md", "/home/operator/project/reports/my%20report.md#result", "/home/operator/project/"), "reports/my report.md");
  assert.equal(linkedDocument("", "C:\\Work\\Project\\reports\\result.md", "c:\\work\\project"), "reports/result.md");
  for (const href of ["/home/operator/project-other/secret.md", "/home/operator/project/../secret.md", "/home/operator/project/%2e%2e/secret.md", "//example.com/report.md", "https://example.com/report.md"]) {
    assert.equal(linkedDocument("", href, "/home/operator/project"), null, href);
  }
  assert.equal(linkedDocument("", "file:///home/operator/project/report.md", "/home/operator/project"), "report.md");
  assert.equal(linkedDocument("", "/home/operator/project/report.md"), null, "absolute links require the known workspace");
});

test("heading anchors support punctuation, non-English headings and duplicate sections", () => {
  assert.deepEqual(headingAnchors(["Quick start!", "Quick start!", "Résumé", "API & setup"]), ["quick-start", "quick-start-1", "résumé", "api--setup"]);
});

test("recommended documents keep generated session history after authored reports and project docs", () => {
  const legacy = "reports/session-2026-09-18T12-34-56-789Z-abcdefgh.md";
  const named = ".remote-agents/artifacts/session-review-mobile-reader-2026-09-18T13-34-56-789Z-12345678.md";
  const mixed = [
    { path: legacy, bytes: 1, mtime: 500 },
    { path: named, bytes: 1, mtime: 600 },
    { path: "docs/session-management.md", bytes: 1, mtime: 300 },
    { path: "README.md", bytes: 1, mtime: 200 },
    { path: "reports/release-review.md", bytes: 1, mtime: 100 },
  ];
  assert.deepEqual(selectDocuments(mixed, "", false, "recommended").map((file) => file.path), [
    "reports/release-review.md", "README.md", "docs/session-management.md", named, legacy,
  ]);
  assert.equal(selectDocuments(mixed, "", false, "recent")[0].path, named);
  assert.equal(selectDocuments(mixed, "session", false, "recommended").length, 3, "session history remains searchable");
});

test("generated report titles remove timestamp and run id clutter without rewriting authored session guides", () => {
  assert.equal(documentTitle("reports/session-2026-09-18T12-34-56-789Z-abcdefgh.md"), "Task summary · 2026-09-18 12:34 UTC");
  assert.equal(documentTitle("reports/session-review-mobile-reader-2026-09-18T13-34-56-789Z-12345678.md"), "Review mobile reader");
  assert.equal(documentTitle("reports/session-fix-2026-schedule-2026-09-18T13-34-56-789Z-12345678.md"), "Fix 2026 schedule");
  assert.equal(documentTitle("docs/session-management.md"), "session management");
  assert.equal(documentTitle("reports/report-review-mobile-reader-2026-09-18T13-34-56-789Z-123456789abc.md"), "Review mobile reader");
  assert.equal(documentTitle("REQUIREMENTS_STATUS_REPORT.md"), "Requirements status report");
  assert.equal(documentTitle("README.markdown"), "README");
  assert.equal(documentTitle("AGENTS.md"), "AGENTS");
});

test("document hrefs are durable app routes for relative, absolute and local file URLs", () => {
  const context = { agentId: "claude-fable-5", cwd: "/home/operator/project", currentPath: "docs/guide.md" };
  for (const href of ["../reports/my%20report.md", "/home/operator/project/reports/my%20report.md", "file:///home/operator/project/reports/my%20report.md"]) {
    assert.equal(documentAppHref(context, href), "/agents/claude-fable-5/documents?path=reports%2Fmy+report.md");
  }
  assert.equal(documentAppHref(context, "/different/project/report.md"), "/agents/claude-fable-5/documents?artifact=report.md");
  for (const href of ["https://example.com/report.md", "javascript:evil.md", "file://remote-host/report.md", "#heading"]) assert.equal(documentAppHref(context, href), null);
  assert.equal(workspaceDocumentPath("reports/literal#and%20.md"), "reports/literal#and%20.md");
  for (const path of ["../secret.md", "/secret.md", "C:\\secret.md", "folder/../../secret.md", "report.txt"]) assert.equal(workspaceDocumentPath(path), null);
});

test("outside-workspace report resolution only finds existing hashed artifact copies", () => {
  const published = [
    { path: ".remote-agents/artifacts/my-report-aabbccdd.md", mtime: 1, bytes: 1 },
    { path: ".remote-agents/artifacts/my-report-12345678.md", mtime: 2, bytes: 1 },
    { path: "reports/my-report.md", mtime: 3, bytes: 1 },
    { path: ".remote-agents/artifacts/unrelated-aabbccdd.md", mtime: 4, bytes: 1 },
  ];
  assert.equal(copiedArtifactCandidates(published, "my report.md").length, 2, "multiple matches remain ambiguous rather than choosing the wrong report");
  assert.equal(copiedArtifactCandidates(published, "missing.md").length, 0);
  assert.equal(copiedArtifactCandidates(published, "../my report.md").length, 0);
});
