import type { WorkspaceFileInfo } from "@remote-agents/shared";

/** Keep operational fixtures available without making them the default reading list. */
export function isSupportingDocument(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return /(^|\/)(?:__tests__|tests?|fixtures?|test-results|coverage|screenshots)(\/|$)/i.test(normalized)
    || /(^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/i.test(normalized)
    || /(^|\/)(?:smoke|e2e|test-fixture|end-to-end-validation-task)(?:[-_.]|$)/i.test(normalized);
}

function generatedDocument(path: string): { kind: string; title: string | undefined; date: string; hour: string; minute: string } | null {
  const filename = (path.split("/").pop() ?? path).replace(/\.(?:md|markdown)$/i, "");
  // Recognize generated names precisely; authored guides such as
  // session-management.md should keep their normal title and priority.
  const match = /^(session|report)-(?:(.+)-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-\d{2}-\d{3}Z-[a-z\d-]+$/i.exec(filename);
  return match ? { kind: match[1], title: match[2], date: match[3], hour: match[4], minute: match[5] } : null;
}

export function documentTitle(path: string): string {
  const session = generatedDocument(path);
  if (session) {
    if (!session.title) return `${session.kind === "session" ? "Task summary" : "Report"} · ${session.date} ${session.hour}:${session.minute} UTC`;
    const title = session.title.replace(/[-_]+/g, " ");
    return title.charAt(0).toUpperCase() + title.slice(1);
  }
  const title = (path.split("/").pop() ?? path).replace(/\.(?:md|markdown)$/i, "").replace(/[-_]+/g, " ");
  // Single-word conventional names (README, AGENTS) stay recognizable, while
  // descriptive SCREAMING_SNAKE_CASE filenames become comfortable card titles.
  return /[A-Z]/.test(title) && title === title.toUpperCase() && /\s/.test(title)
    ? title.charAt(0) + title.slice(1).toLowerCase()
    : title;
}

function documentPriority(path: string): number {
  if (generatedDocument(path)?.kind === "session") return 3;
  if (/^(?:reports\/|\.remote-agents\/artifacts\/)/i.test(path)) return 0;
  return path.includes("/") ? 2 : 1;
}

export function selectDocuments(files: WorkspaceFileInfo[], query: string, includeSupporting: boolean, sort: "recommended" | "recent" | "name"): WorkspaceFileInfo[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return files.filter((file) => (includeSupporting || words.length > 0 || !isSupportingDocument(file.path))
    && words.every((word) => file.path.toLowerCase().includes(word)))
    .sort((a, b) => {
      if (sort === "name") return a.path.localeCompare(b.path);
      return (sort === "recommended" ? documentPriority(a.path) - documentPriority(b.path) : 0) || b.mtime - a.mtime || a.path.localeCompare(b.path);
    });
}

export type DocumentContext = { agentId: string; cwd?: string; currentPath?: string };

/** Parse local Markdown destinations without allowing network or executable URLs. */
function localMarkdownPath(href: string): string | null {
  if (href.startsWith("#")) return null;
  let raw = href.split(/[?#]/)[0];
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname && url.hostname !== "localhost") return null;
      raw = url.pathname.replace(/^\/([a-z]:\/)/i, "$1");
    } catch { return null; }
  }
  let path: string;
  try { path = decodeURIComponent(raw); } catch { return null; }
  const windowsPath = /^[a-z]:[\\/]/i.test(path);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !windowsPath) return null;
  if (!/\.(?:md|markdown)$/i.test(path) || /[\u0000\r\n]/.test(path) || path.startsWith("//")) return null;
  return path;
}

/** Resolve report links within this workspace; the server still enforces file boundaries. */
export function linkedDocument(currentPath: string, href: string, cwd?: string): string | null {
  let path = localMarkdownPath(href);
  if (!path) return null;
  const windowsPath = /^[a-z]:[\\/]/i.test(path);
  let fromRoot = false;
  if (path.startsWith("/") || windowsPath) {
    if (!cwd) return null;
    const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    path = path.replace(/\\/g, "/");
    if (!(windowsPath ? path.toLowerCase().startsWith(root.toLowerCase()) : path.startsWith(root))) return null;
    path = path.slice(root.length);
    fromRoot = true;
  }
  if (path.includes("\\")) return null;
  const parts = fromRoot ? [] : currentPath.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Validate an already-decoded app query path without decoding filenames twice. */
export function workspaceDocumentPath(path: string): string | null {
  if (!/\.(?:md|markdown)$/i.test(path) || /[\\\u0000\r\n]/.test(path) || path.startsWith("/") || /^[a-z]:/i.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === "..")) return null;
  return parts.filter((part) => part && part !== ".").join("/") || null;
}

/** Durable app destinations work for click, long-press, middle-click and shared links. */
export function documentAppHref(context: DocumentContext, href: string): string | null {
  const localPath = localMarkdownPath(href);
  if (!localPath) return null;
  const path = linkedDocument(context.currentPath ?? "", href, context.cwd);
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  else query.set("artifact", localPath.replace(/\\/g, "/").split("/").pop()!);
  return `/agents/${encodeURIComponent(context.agentId)}/documents?${query}`;
}

/** Only existing worker-published artifact copies can satisfy an external link. */
export function copiedArtifactCandidates(files: WorkspaceFileInfo[], sourceName: string): WorkspaceFileInfo[] {
  if (!/^[^/\\]+\.(?:md|markdown)$/i.test(sourceName)) return [];
  const stem = sourceName.replace(/[^\w.\-]+/g, "-").replace(/\.(?:md|markdown)$/i, "") || "report";
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.remote-agents/artifacts/${escaped}-[a-f0-9]{8}\\.md$`, "i");
  return files.filter((file) => pattern.test(file.path));
}

/** GitHub-style heading fragments, including repeated heading disambiguation. */
export function headingAnchors(titles: string[]): string[] {
  const counts = new Map<string, number>();
  return titles.map((title) => {
    const base = title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    return occurrence ? `${base}-${occurrence}` : base;
  });
}
