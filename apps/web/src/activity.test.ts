import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityResponse, activitySteps, currentActivityTranscript, describeAction, parseActivityTranscript } from "./activity.js";

describe("human-readable activity", () => {
  it("pairs repeated command completions only with their own unfinished invocation", () => {
    const steps = activitySteps(parseActivityTranscript("→ shell npm test\n✓ shell npm test\n→ shell npm test"));
    assert.equal(steps.length, 2);
    assert.equal(steps[0].completed, true);
    assert.equal(steps[1].completed, false);
    assert.equal(steps[0].title, "Command finished");
    assert.doesNotMatch(steps[0].title, /pass|success/i);
  });

  it("keeps markdown, error details and unknown tools without inventing a summary", () => {
    const entries = parseActivityTranscript("→ futureTool input\n# Result\n\nTests failed: expected 2, got 1.\n\n- Fix pending\n> quoted evidence");
    assert.equal(activitySteps(entries)[0].detail, "futureTool input");
    assert.equal(activityResponse(entries, null).latest, "# Result\n\nTests failed: expected 2, got 1.\n\n- Fix pending\n> quoted evidence");
    assert.equal(describeAction("report: docs/review.md").title, "Report available");
  });

  it("does not reinterpret tool or thinking markers within fenced code", () => {
    const entries = parseActivityTranscript("Example:\n````text\n→ shell do-not-run\n```\n[thinking] literal\n````\n✓ read README.md");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, "message");
    assert.match(entries[0].text, /→ shell do-not-run/);
    assert.equal(activitySteps(entries).length, 1);
  });

  it("keeps reasoning separate and preserves earlier messages", () => {
    const entries = parseActivityTranscript("First update\n[thinking] Reviewing options\n→ read README.md\nFinal update");
    assert.equal(entries[1].kind, "thinking");
    assert.equal(activityResponse(entries, null).latest, "Final update");
    assert.equal(activityResponse(entries, null).earlier[0].text, "First update");
  });

  it("removes only the exact known prompt and preserves markdown quotes", () => {
    const entries = parseActivityTranscript("> Review this\nwith care\nThe review is complete.\n> Keep this quote");
    assert.equal(activityResponse(entries, "Review this\nwith care").latest, "The review is complete.\n> Keep this quote");
    assert.equal(activityResponse(parseActivityTranscript("> Review this longer"), "Review this").latest, "> Review this longer");
  });

  it("handles delegated task lifecycle and unmatched completion without claiming success", () => {
    const steps = activitySteps(parseActivityTranscript("⧉ subagent Review API started\n⧉ subagent Review API finished\n✓ shell lint"));
    assert.deepEqual(steps.map((step) => step.title), ["Delegated task finished", "Command finished"]);
  });
});

describe("multiline Codex shell activity", () => {
  it("keeps heredoc commands inside their started/completed step and preserves genuine prose", () => {
    const command = `/bin/zsh -lc "python3 - <<'PY'\nfrom pathlib import Path\nPath('reports/result.md').write_text('Done')\nPY"`;
    const entries = parseActivityTranscript(`I will write the report.\n→ ${command}\n✓ ${command}\nThe report is ready.\n\n- Validation passed.`);
    assert.equal(entries.length, 4);
    assert.equal(entries[1].text, command);
    assert.equal(entries[2].text, command);
    const steps = activitySteps(entries);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].title, "Command finished");
    assert.equal(steps[0].detail, command);
    assert.equal(activityResponse(entries, null).latest, "The report is ready.\n\n- Validation passed.");
    assert.equal(activityResponse(entries, null).earlier[0].text, "I will write the report.");
  });

  it("handles escaped quotes without exposing the rest of a shell script as prose", () => {
    const command = '/bin/bash -c "printf \\"hello\\"\nprintf done\n"';
    const entries = parseActivityTranscript(`→ ${command}\nA separate update.`);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].text, command);
    assert.equal(activityResponse(entries, null).latest, "A separate update.");
  });

  it("never consumes following messages for single-line commands or incomplete quoted labels", () => {
    for (const command of ['/bin/zsh -lc "pwd"', '/bin/zsh -lc "truncated']) {
      const entries = parseActivityTranscript(`→ ${command}\nThe agent reported an error.\n✓ read README.md\nNext update.`);
      assert.equal(entries[0].text, command);
      assert.equal(entries[1].text, "The agent reported an error.");
      assert.equal(entries[2].kind, "action");
      assert.equal(entries[3].text, "Next update.");
    }
  });
});


describe("current run activity", () => {
  it("does not present a submitted instruction as an agent response", () => {
    const prompt = "Review this repository\nand write a report.";
    const current = currentActivityTranscript(`> ${prompt}`, prompt, true);
    assert.equal(current, "");
    assert.equal(activityResponse(parseActivityTranscript(current), prompt).latest, "");
  });

  it("selects the last exact prompt boundary and excludes earlier runs", () => {
    const log = "> Review\nOld response\n> Review longer\nAnother response\n> Review\nCurrent response\n> A Markdown quote";
    const current = currentActivityTranscript(log, "Review", true, true);
    assert.equal(current, "Current response\n> A Markdown quote");
    assert.equal(activityResponse(parseActivityTranscript(current), "Review").latest, current);
    assert.equal(activityResponse(parseActivityTranscript(current), "Review").earlier.length, 0);
  });

  it("keeps previous responses out of a starting task whose prompt has not arrived", () => {
    const old = "> Earlier task\nTask completed.";
    assert.equal(currentActivityTranscript(old, "New task", true), "");
    assert.equal(currentActivityTranscript(old, null, true), old);
    assert.equal(currentActivityTranscript(old, "New task", false), old);
    assert.equal(currentActivityTranscript("A retained tail after the log cap", "Long task", true, true), "A retained tail after the log cap");
  });

  it("hides a previous identical task while the new run is still starting", () => {
    assert.equal(currentActivityTranscript("> Review\nEarlier result", "Review", true, false), "");
  });

  it("requires both line-start and exact prompt-end boundaries", () => {
    const log = "Discuss > Review\nA response\n> Review more\nAnother response";
    assert.equal(currentActivityTranscript(log, "Review", true, true), log);
    const prefixOnly = "> Review more\nNot the requested task";
    assert.equal(currentActivityTranscript(prefixOnly, "Review", true, true), prefixOnly);
  });
});
