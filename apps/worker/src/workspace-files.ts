import fs from "node:fs";
import { readBoundedFile } from "./path-guards";
import path from "node:path";
import type { WorkspaceFileContent, WorkspaceFileInfo } from "@remote-agents/shared";
import {
  ARTIFACTS_DIR,
  MAX_BYTES,
  assertNoSymlinkAncestors,
  assertReadableFile,
  assertReadableInside,
  isMarkdownPath,
  resolveInside,
} from "./path-guards";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".cursor"]);
const MAX_FILES = 200;
const MAX_ENTRIES = 10_000;

function newestFirst(a: WorkspaceFileInfo, b: WorkspaceFileInfo): number {
  return b.mtime - a.mtime || a.path.localeCompare(b.path, "en", { sensitivity: "base" });
}

function documentPriority(file: WorkspaceFileInfo): number {
  if (file.path.startsWith("reports/") || file.path.startsWith(".remote-agents/artifacts/")) return 0;
  return file.path.includes("/") ? 2 : 1;
}

function relevantFirst(a: WorkspaceFileInfo, b: WorkspaceFileInfo): number {
  return documentPriority(a) - documentPriority(b) || newestFirst(a, b);
}

/** Keep memory bounded while still considering newer files after the first page. */
function keepFile(out: WorkspaceFileInfo[], file: WorkspaceFileInfo, compare = newestFirst): void {
  let low = 0;
  let high = out.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(file, out[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= MAX_FILES) return;
  out.splice(low, 0, file);
  if (out.length > MAX_FILES) out.pop();
}

export { MAX_BYTES, isMarkdownPath, resolveInside };

export function listWorkspaceMarkdown(root: string): WorkspaceFileInfo[] {
  const rootAbs = path.resolve(root);
  if (!fs.existsSync(rootAbs)) return [];
  const out: WorkspaceFileInfo[] = [];

  // Bound traversal even when a workspace contains few Markdown files.
  const MAX_DIRECTORIES = 256;
  const MAX_DEPTH = 8;
  let directories = 0;
  let inspected = 0;
  const pending: { dir: string; depth: number }[] = [];
  const reports = path.join(rootAbs, "reports");

  const scan = (dir: string, depth: number) => {
    if (directories >= MAX_DIRECTORIES || inspected >= MAX_ENTRIES) return;
    directories++;
    let handle: fs.Dir;
    try {
      assertNoSymlinkAncestors(rootAbs, dir);
      if (!fs.lstatSync(dir).isDirectory()) return;
      handle = fs.opendirSync(dir);
    } catch {
      return;
    }
    try {
      let entry: fs.Dirent | null;
      while (inspected < MAX_ENTRIES && (entry = handle.readSync())) {
        inspected++;
        if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        if (entry.isFile() && !isMarkdownPath(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        // Root reports are scanned explicitly first, never through this queue.
        if (abs === reports) continue;
        let st: fs.Stats;
        try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (depth < MAX_DEPTH && directories + pending.length < MAX_DIRECTORIES) {
            pending.push({ dir: abs, depth: depth + 1 });
          }
          continue;
        }
        if (!st.isFile()) continue;
        const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
        if (!isMarkdownPath(rel)) continue;
        try {
          assertNoSymlinkAncestors(rootAbs, abs);
          const fileSt = assertReadableFile(abs, MAX_BYTES);
          keepFile(out, { path: rel, bytes: fileSt.size, mtime: fileSt.mtimeMs }, relevantFirst);
        } catch {
          /* skip unsafe/unreadable */
        }
      }
    } catch {
      // A directory may disappear or become unreadable during enumeration.
    } finally {
      handle.closeSync();
    }
  };

  // Reserve discovery priority for deliverables, then top-level workspace files.
  // Only afterwards visit nested projects, breadth first and without recursion.
  scan(reports, 1);
  scan(rootAbs, 0);
  while (pending.length && inspected < MAX_ENTRIES) {
    const next = pending.shift()!;
    scan(next.dir, next.depth);
  }
  return out;
}

export function listArtifactMarkdown(
  workspaceRoot: string,
  maxBytes: number = MAX_BYTES
): WorkspaceFileInfo[] {
  const rootAbs = path.resolve(workspaceRoot);
  let artifactsAbs: string;
  try {
    artifactsAbs = resolveInside(workspaceRoot, ARTIFACTS_DIR);
    assertNoSymlinkAncestors(rootAbs, artifactsAbs);
  } catch {
    return [];
  }
  if (!fs.existsSync(artifactsAbs)) return [];
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(artifactsAbs);
  } catch {
    return [];
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];

  const out: WorkspaceFileInfo[] = [];
  let handle: fs.Dir;
  try { handle = fs.opendirSync(artifactsAbs); } catch { return []; }
  try {
    let entry: fs.Dirent | null;
    let inspected = 0;
    while (inspected < MAX_ENTRIES && (entry = handle.readSync())) {
      inspected++;
      if (!entry.isFile() || !isMarkdownPath(entry.name)) continue;
      const abs = path.join(artifactsAbs, entry.name);
      const rel = path.join(ARTIFACTS_DIR, entry.name).split(path.sep).join("/");
      try {
        assertNoSymlinkAncestors(rootAbs, abs);
        const fileSt = assertReadableFile(abs, maxBytes);
        keepFile(out, { path: rel, bytes: fileSt.size, mtime: fileSt.mtimeMs });
      } catch {
        // Skip unsafe/unreadable artifacts without losing other documents.
      }
    }
  } catch {
    // A directory may disappear or become unreadable during enumeration.
  } finally { handle.closeSync(); }
  return out;
}

export function listMarkdownFiles(root: string): WorkspaceFileInfo[] {
  const merged = new Map<string, WorkspaceFileInfo>();
  for (const file of [...listWorkspaceMarkdown(root), ...listArtifactMarkdown(root)]) {
    merged.set(file.path, file);
  }
  const out = [...merged.values()];
  out.sort(relevantFirst);
  return out.slice(0, MAX_FILES);
}

export function readMarkdownFile(root: string, relPath: string): WorkspaceFileContent {
  if (!isMarkdownPath(relPath)) {
    throw new Error("Only markdown files can be opened");
  }
  const { abs, st } = assertReadableInside(root, relPath, MAX_BYTES);
  const content = readBoundedFile(abs);
  const rel = path.relative(path.resolve(root), abs).split(path.sep).join("/");
  return { path: rel, content, bytes: st.size, mtime: st.mtimeMs };
}
