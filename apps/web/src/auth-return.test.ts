import assert from "node:assert/strict";
import test from "node:test";
import { safeReturnPath } from "./auth-return.js";

test("sign-in preserves durable document query parameters while rejecting unsafe redirects", () => {
  const report = "/agents/claude-fable-5/documents?path=reports%2Fmy+report.md";
  assert.equal(safeReturnPath(report), report);
  assert.equal(safeReturnPath("/agents"), "/agents");
  for (const value of [undefined, null, {}, 42, "https://example.com", "//example.com", "/\\example.com", "/\n/evil", "/login?again=true", "javascript:alert(1)"]) {
    assert.equal(safeReturnPath(value), "/overview");
  }
});
