import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACTS_DIR,
  MAX_BYTES,
  REPORTS_DIR,
  assertNoSymlinkAncestors,
  assertNoSymlinkInSourcePath,
  assertReadableFile,
  ensureDirectoryInside,
  isInsideRoot,
  isMarkdownPath,
  resolveInside,
  writeFileInside,
  readBoundedFile,
} from "./path-guards";

export { ARTIFACTS_DIR, REPORTS_DIR };
export { assertNoSymlinkAncestors } from "./path-guards";

export const REPORT_TASK_MARKER = "[Remote Agents]";
export const MAX_PRODUCED_PATHS = 32;

export const REPORT_TASK_INSTRUCTION = `${REPORT_TASK_MARKER} When you finish, write a durable markdown report under \`${REPORTS_DIR}/\` in this workspace (create the folder if needed). Give it a descriptive title and a short outcome first, followed by changes, validation evidence, and any unresolved work. Name it clearly and mention the path in your reply. Prefer a real markdown file over chat-only output for substantial work.`;

export type RunReportStatus = "finished" | "error" | "cancelled";

export function reportHintsEnabled(): boolean {
  return process.env.REMOTE_AGENTS_DISABLE_REPORT_HINTS !== "1";
}

export function withReportInstruction(userText: string, reportPath?: string): string {
  const trimmed = userText.trim();
  if (!reportHintsEnabled()) return userText;
  if (trimmed.includes(REPORT_TASK_MARKER)) return userText;
  const target = reportPath ? ` For this run, save the report to \`${reportPath}\` unless the user requests a different output path.` : "";
  return `${REPORT_TASK_INSTRUCTION}${target}\n\n${userText}`;
}

export function extractWritePathsFromEvent(event: unknown): string[] {
  if (!event || typeof event !== "object") return [];
  const ev = event as {
    type?: string;
    subtype?: string;
    status?: string;
    is_error?: boolean;
    tool_call?: Record<string, { args?: Record<string, unknown> } | unknown>;
  };
  if (ev.type !== "tool_call" || ev.is_error) return [];
  if (ev.subtype !== "completed" && ev.status !== "completed") return [];
  const paths: string[] = [];
  for (const [name, entry] of Object.entries(ev.tool_call || {})) {
    if (!/^(?:write|edit|str_replace|strReplace|createFile|writeFile|editFile)ToolCall$/i.test(name)) continue;
    if (!entry || typeof entry !== "object") continue;
    const args = (entry as { args?: Record<string, unknown> }).args;
    if (!args) continue;
    for (const key of ["path", "targetFile", "relativePath", "file_path"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) paths.push(value.trim());
    }
  }
  return paths;
}

function safeArtifactName(sourcePath: string): string {
  const base = path.basename(sourcePath).replace(/[^\w.\-]+/g, "-");
  const stem = base.replace(/\.(md|markdown)$/i, "") || "report";
  const hash = createHash("sha256").update(sourcePath).digest("hex").slice(0, 8);
  return `${stem}-${hash}.md`;
}

export function copyExternalMarkdownToArtifacts(
  workspaceRoot: string,
  sourcePath: string,
  maxBytes = MAX_BYTES
): string | null {
  const abs = path.resolve(sourcePath);
  if (!isMarkdownPath(abs)) return null;
  if (isInsideRoot(workspaceRoot, abs)) return null;
  try {
    assertNoSymlinkInSourcePath(abs);
    assertReadableFile(abs, maxBytes);
  } catch {
    return null;
  }

  const destRel = path.join(ARTIFACTS_DIR, safeArtifactName(abs)).split(path.sep).join("/");
  try {
    ensureDirectoryInside(workspaceRoot, ARTIFACTS_DIR);
    const destAbs = resolveInside(workspaceRoot, destRel);
    assertNoSymlinkAncestors(path.resolve(workspaceRoot), destAbs);
    writeFileInside(workspaceRoot, destRel, readBoundedFile(abs, maxBytes));
    return destRel;
  } catch {
    return null;
  }
}

/** Parse a Markdown inline-link destination, including `<...>` and balanced parentheses. */
export function extractLinkDestination(raw: string): string | null {
  const src = raw.trim();
  if (!src.startsWith("(")) return null;
  let i = 1;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] === "<") {
    const end = src.indexOf(">", i + 1);
    if (end < 0) return null;
    return src.slice(i + 1, end).trim() || null;
  }
  let depth = 1;
  const start = i;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i).trim() || null;
    }
  }
  return null;
}

export function extractMarkdownLinks(text: string): string[] {
  const found = new Set<string>();
  const openerRe = /\[[^\]]*\](?=\()/g;
  let match: RegExpExecArray | null;
  while ((match = openerRe.exec(text))) {
    const dest = extractLinkDestination(text.slice(match.index + match[0].length));
    if (dest && !/^https?:/i.test(dest)) found.add(dest);
  }
  const bareRe = /(?:^|\s)([\w./-]+\.(?:md|markdown))(?:\s|$)/gi;
  while ((match = bareRe.exec(text))) {
    found.add(match[1].trim());
  }
  return [...found];
}

export function resolveProducedMarkdownPath(
  workspaceRoot: string,
  rawPath: string
): string | null {
  const cleaned = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || !isMarkdownPath(cleaned)) return null;
  if (cleaned.includes("..")) return null;
  try {
    const rootAbs = path.resolve(workspaceRoot);
    const abs = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : resolveInside(workspaceRoot, cleaned);
    if (!isInsideRoot(rootAbs, abs)) return null;
    assertNoSymlinkAncestors(rootAbs, abs);
    assertReadableFile(abs, MAX_BYTES);
    return path.relative(rootAbs, abs).split(path.sep).join("/");
  } catch {
    return null;
  }
}

/** Keep task names readable without putting credentials, URLs or paths in filenames. */
function reportSlug(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0] || "";
  if (/password|passwd|secret|token|credential|api[ _-]?key|https?:|[\\/]|@|[A-Za-z0-9_-]{24,}/i.test(firstLine)) return "";
  let slug = "";
  for (const word of (firstLine.toLowerCase().match(/[a-z]{2,}/g) || []).slice(0, 7)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 48) break;
    slug = next;
  }
  return slug;
}

function reportBasename(prefix: "report" | "session", prompt: string, runId?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = createHash("sha256").update(runId || randomUUID()).digest("hex").slice(0, 12);
  const slug = reportSlug(prompt);
  return `${prefix}-${slug ? `${slug}-` : ""}${stamp}-${suffix}.md`;
}

/** A unique destination identifies this run's Bash-written report without mtime inference. */
export function createRunReportPath(userPrompt: string): string {
  return `${REPORTS_DIR}/${reportBasename("report", userPrompt)}`;
}

export function buildTranscriptReportContent(opts: {
  status: RunReportStatus;
  transcript: string;
  headline: string;
  userPrompt: string;
}): string {
  const statusLine =
    opts.status === "finished"
      ? "completed"
      : opts.status === "cancelled"
        ? "cancelled"
        : "ended with an error";
  const body = opts.transcript.trim() || opts.headline.trim() || "_No assistant text was captured._";
  return [
    "# Session report (auto-generated)",
    "",
    `Remote Agents saved this markdown because no agent-authored report file was detected in this workspace when the run ${statusLine}.`,
    "",
    "The content below is a transcript of the assistant response, not a separately authored document.",
    "",
    "## Prompt",
    "",
    opts.userPrompt.trim() || "_No prompt captured._",
    "",
    "## Assistant output",
    "",
    body,
    "",
  ].join("\n");
}

export function materializeTranscriptReport(opts: {
  workspaceRoot: string;
  runId?: string;
  status: RunReportStatus;
  transcript: string;
  headline: string;
  userPrompt: string;
}): string | null {
  const transcript = opts.transcript.trim();
  const headline = opts.headline.trim();
  if (!transcript && !headline) return null;

  const rel = path.join(REPORTS_DIR, reportBasename("session", opts.userPrompt, opts.runId)).split(path.sep).join("/");
  writeFileInside(opts.workspaceRoot, rel, buildTranscriptReportContent(opts));
  return rel;
}

export interface FinalizeRunReportsInput {
  workspaceRoot: string;
  runId?: string;
  status: RunReportStatus;
  transcript: string;
  headline: string;
  userPrompt: string;
  producedPaths: string[];
  requestedReportPath?: string;
}

export interface FinalizeRunReportsResult {
  artifactCopies: string[];
  workspaceMarkdown: string[];
  defaultReportPath: string | null;
}

export function finalizeRunReports(input: FinalizeRunReportsInput): FinalizeRunReportsResult {
  const workspaceMarkdown = new Set<string>();
  const artifactCopies: string[] = [];
  // A final answer can link a report written through Bash rather than a typed file tool.
  // Linked existing workspace files are context, not proof a fresh report was authored.
  const linkedExternal = extractMarkdownLinks(input.transcript).filter(
    (file) => path.isAbsolute(file) && !isInsideRoot(input.workspaceRoot, file)
  );
  const requested = input.requestedReportPath ? [input.requestedReportPath] : [];
  const produced = [...new Set([...requested, ...input.producedPaths, ...linkedExternal])].slice(0, MAX_PRODUCED_PATHS);

  for (const raw of produced) {
    const inWorkspace = resolveProducedMarkdownPath(input.workspaceRoot, raw);
    if (inWorkspace) {
      workspaceMarkdown.add(inWorkspace);
      continue;
    }
    const copied = copyExternalMarkdownToArtifacts(input.workspaceRoot, raw);
    if (copied) artifactCopies.push(copied);
  }

  const defaultReportPath =
    workspaceMarkdown.size === 0 && artifactCopies.length === 0
      ? materializeTranscriptReport({
          workspaceRoot: input.workspaceRoot,
          runId: input.runId,
          status: input.status,
          transcript: input.transcript,
          headline: input.headline,
          userPrompt: input.userPrompt,
        })
      : null;

  return {
    artifactCopies,
    workspaceMarkdown: [...workspaceMarkdown],
    defaultReportPath,
  };
}
