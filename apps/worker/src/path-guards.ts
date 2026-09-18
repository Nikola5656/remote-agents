import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_BYTES = 512 * 1024;
export const REPORTS_DIR = "reports";
export const ARTIFACTS_DIR = path.join(".remote-agents", "artifacts");

export function isMarkdownPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

export function resolveInside(root: string, relPath: string): string {
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) {
    throw new Error("Invalid path");
  }
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, cleaned);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
  if (abs !== rootAbs && !abs.startsWith(prefix)) {
    throw new Error("Path escapes workspace");
  }
  return abs;
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(candidate);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
  return abs === rootAbs || abs.startsWith(prefix);
}

/** Reject symlink components between root and target (both must stay inside root). */
export function assertNoSymlinkAncestors(rootAbs: string, targetAbs: string): void {
  const root = path.resolve(rootAbs);
  const target = path.resolve(targetAbs);
  if (!isInsideRoot(root, target)) {
    throw new Error("Path escapes workspace");
  }
  let current = root;
  const rel = path.relative(root, target);
  if (!rel || rel === ".") return;
  for (const part of rel.split(path.sep)) {
    if (!part || part === ".") continue;
    current = path.join(current, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    if (st.isSymbolicLink()) {
      throw new Error("Symlinks are not allowed");
    }
  }
}

/** Reject symlink parents on an external source path (stops at tmpdir realpath). */
export function assertNoSymlinkInSourcePath(absPath: string): void {
  const target = path.resolve(absPath);
  const fileSt = fs.lstatSync(target);
  if (fileSt.isSymbolicLink()) {
    throw new Error("Symlinks are not allowed");
  }
  const tmpRoot = fs.realpathSync(os.tmpdir());
  let current = path.dirname(target);
  while (true) {
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) {
      throw new Error("Symlinks are not allowed");
    }
    if (fs.realpathSync(current) === tmpRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function assertReadableFile(abs: string, maxBytes: number = MAX_BYTES): fs.Stats {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new Error("Symlinks are not allowed");
  }
  if (!st.isFile()) {
    throw new Error("Not a file");
  }
  if (st.size > maxBytes) {
    throw new Error(`File is larger than ${maxBytes} bytes`);
  }
  return st;
}

/** Create each directory segment under root without following symlink parents. */
export function ensureDirectoryInside(root: string, relDir: string): string {
  const rootAbs = path.resolve(root);
  const targetAbs = resolveInside(root, relDir);
  const rel = path.relative(rootAbs, targetAbs);
  const parts = rel.split(path.sep).filter(Boolean);
  let current = rootAbs;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current);
      continue;
    }
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) {
      throw new Error("Symlinks are not allowed");
    }
    if (!st.isDirectory()) {
      throw new Error("Not a directory");
    }
  }
  return targetAbs;
}

export function writeFileInside(root: string, relPath: string, content: string): string {
  const rootAbs = path.resolve(root);
  const abs = resolveInside(root, relPath);
  const parentRel = path.dirname(relPath.replace(/\\/g, "/"));
  if (parentRel && parentRel !== ".") {
    ensureDirectoryInside(root, parentRel);
  }
  assertNoSymlinkAncestors(rootAbs, abs);
  const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, content, "utf8"); } finally { fs.closeSync(fd); }
  return abs;
}

export function assertReadableInside(
  root: string,
  relPath: string,
  maxBytes: number = MAX_BYTES
): { abs: string; st: fs.Stats } {
  const rootAbs = path.resolve(root);
  const abs = resolveInside(root, relPath);
  assertNoSymlinkAncestors(rootAbs, abs);
  const st = assertReadableFile(abs, maxBytes);
  return { abs, st };
}

/** Bound the actual read, including files that grow after their initial stat. */
export function readBoundedFile(abs: string, maxBytes = MAX_BYTES): string {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) throw new Error("Markdown exceeds the file limit or is not a regular file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > maxBytes) throw new Error("Markdown exceeds the file limit");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally { fs.closeSync(fd); }
}
