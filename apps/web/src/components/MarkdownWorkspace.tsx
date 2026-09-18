import type {
  AgentStatus,
  DeliveryMode,
  WorkspaceFileContent,
  WorkspaceFileInfo,
} from "@remote-agents/shared";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  AuthError,
  fetchAgentFile,
  fetchAgentFiles,
  requestAgentMarkdown,
} from "../api";
import { formatBytes, formatElapsed, formatRelative } from "../format";
import { useNow } from "../hooks";
import { useToast } from "../toast";
import { copiedArtifactCandidates, documentTitle, isSupportingDocument, linkedDocument, selectDocuments, workspaceDocumentPath } from "../documents";
import "./documents.css";
import { MarkdownReader } from "./MarkdownReader";

type Props = {
  agentId: string;
  agentName: string;
  agentStatus: AgentStatus;
  cwd?: string;
  onAuthLost: () => void;
  active?: boolean;
  openRequest?: { path?: string; artifact?: string } | null;
};

type PendingWrite = {
  path: string;
  startedAt: number;
  /** mtime of the file before we asked, so we detect a fresh write (null = didn't exist). */
  prevMtime: number | null;
};

const LIST_POLL_MS = 20_000;
const WRITE_POLL_MS = 5_000;
const WRITE_TIMEOUT_MS = 5 * 60_000;

export function MarkdownWorkspace({
  agentId,
  agentName,
  agentStatus,
  cwd,
  onAuthLost,
  active = true,
  openRequest,
}: Props) {
  const toast = useToast();
  const [files, setFiles] = useState<WorkspaceFileInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [includeSupporting, setIncludeSupporting] = useState(false);
  const [sort, setSort] = useState<"recommended" | "recent" | "name">("recommended");
  const [shown, setShown] = useState(12);
  const [refreshing, setRefreshing] = useState(false);
  const listRequest = useRef(false);
  const lastOpenRequest = useRef<typeof openRequest>(null);
  const alive = useRef(true);
  const openSequence = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const [doc, setDoc] = useState<WorkspaceFileContent | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ path: string; message: string; artifact?: boolean } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [reqPath, setReqPath] = useState("");
  const [instruct, setInstruct] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const now = useNow(1000, pending !== null);
  const prevStatusRef = useRef(agentStatus);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const loadList = useCallback(
    async (silent = true) => {
      if (listRequest.current) return;
      listRequest.current = true;
      if (!silent) setRefreshing(true);
      try {
        const next = await fetchAgentFiles(agentId, AbortSignal.timeout(15_000));
        if (!alive.current) return;
        next.sort((a, b) => b.mtime - a.mtime);
        setFiles(next);
        setListError(null);
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthLost();
          return;
        }
        if (!silent) {
          setListError(
            err instanceof Error ? err.message : "Could not list files"
          );
        }
      } finally {
        listRequest.current = false;
        if (alive.current) setRefreshing(false);
      }
    },
    [agentId, onAuthLost]
  );

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // A hidden Documents tab does no background enumeration. Pending requests
  // still track their specific file and announce completion through a toast.
  useEffect(() => {
    if (!active) return;
    void loadList(false);
    const t = window.setInterval(() => void loadList(), LIST_POLL_MS);
    return () => window.clearInterval(t);
  }, [active, loadList]);

  const openPath = useCallback(
    async (rel: string, silent = false) => {
      const clean = rel.trim();
      if (!clean) return;
      if (!doc && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
      const sequence = ++openSequence.current;
      setOpenError(null);
      setOpeningPath(clean);
      try {
        const file = await fetchAgentFile(agentId, clean, AbortSignal.timeout(15_000));
        if (!alive.current || sequence !== openSequence.current) return;
        setDoc(file);
        setListError(null);
      } catch (err) {
        if (err instanceof AuthError) {
          onAuthLost();
          return;
        }
        if (!silent && alive.current && sequence === openSequence.current) {
          setOpenError({
            path: clean,
            message: err instanceof ApiError && err.status === 503
              ? "The worker is unavailable. Reconnect it, then try again."
              : "This document could not be opened. It may still be being written, have moved, or be unavailable in this workspace. Try again or choose another document below.",
          });
        }
      } finally {
        if (alive.current && sequence === openSequence.current) setOpeningPath(null);
      }
    },
    [agentId, doc, onAuthLost, toast]
  );

  useEffect(() => {
    if (!active || !openRequest || lastOpenRequest.current === openRequest) return;
    if (openRequest.artifact && !files) return;
    lastOpenRequest.current = openRequest;
    if (openRequest.path) {
      const safePath = workspaceDocumentPath(openRequest.path);
      if (safePath) void openPath(safePath);
      else setOpenError({ path: openRequest.path, message: "This link does not identify a Markdown document inside the workspace. Choose a document below." });
      return;
    }
    if (openRequest.artifact) {
      const matches = copiedArtifactCandidates(files ?? [], openRequest.artifact);
      if (matches.length === 1) { void openPath(matches[0].path); return; }
      setFilter(openRequest.artifact.replace(/[^\w.\-]+/g, "-").replace(/\.(?:md|markdown)$/i, ""));
      setIncludeSupporting(true);
      setOpenError({ path: openRequest.artifact, artifact: true, message: matches.length > 1
        ? "Several published copies match this report. Choose the intended document below."
        : "This report was linked outside the workspace, and no published copy is available yet. Let the task finish, then refresh, or ask the agent to save it in reports/." });
    }
  }, [active, files, openRequest, openPath]);

  // Refresh the list when the agent goes back to idle (it may have just written files).
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = agentStatus;
    if (active && prev === "running" && agentStatus !== "running") {
      void loadList();
    }
  }, [active, agentStatus, loadList]);

  // While waiting for a requested file: poll, auto-open on success, time out.
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let checking = false;
    const check = async () => {
      const current = pendingRef.current;
      if (!current || cancelled || checking) return;
      checking = true;
      try {
        const file = await fetchAgentFile(agentId, current.path, AbortSignal.timeout(15_000));
        if (cancelled) return;
        const fresh =
          current.prevMtime === null
            ? file.content.trim().length > 0
            : file.mtime > current.prevMtime;
        if (fresh) {
          setPending(null);
          setDoc(file);
          toast.push(`${current.path} is ready`, "success");
          void loadList();
          return;
        }
      } catch (err) {
        if (err instanceof AuthError) { onAuthLost(); setPending(null); return; }
        /* file not written yet */
      } finally { checking = false; }
      if (cancelled) return;
      if (Date.now() - current.startedAt > WRITE_TIMEOUT_MS) {
        setPending(null);
        toast.push(
          `Stopped watching ${current.path} after 5 minutes. The request may still be queued or running; check Activity before requesting it again.`,
          "error"
        );
      }
    };
    const t = window.setInterval(() => void check(), WRITE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [pending, agentId, loadList, toast, onAuthLost]);

  async function onRequest(mode: DeliveryMode, e?: FormEvent) {
    e?.preventDefault();
    const clean = linkedDocument("workspace.md", reqPath.trim());
    if (!clean) {
      toast.push("Use a Markdown file name inside this workspace, e.g. reports/summary.md", "error");
      return;
    }
    setRequesting(true);
    try {
      // Capture the current mtime (if the file exists) so we can tell old from new.
      let prevMtime: number | null = files?.find((file) => file.path === clean)?.mtime ?? null;
      try {
        const existing = await fetchAgentFile(agentId, clean, AbortSignal.timeout(15_000));
        prevMtime = existing.mtime;
      } catch (err) {
        if (err instanceof AuthError || !(err instanceof ApiError) || ![404, 502].includes(err.status)) throw err;
        /* The worker currently returns 502 for missing files as well as read failures. */
      }
      await requestAgentMarkdown(agentId, {
        path: clean,
        instruct: instruct.trim() || undefined,
        mode,
      });
      setPending({ path: clean, startedAt: Date.now(), prevMtime });
      toast.push(
        mode === "interrupt"
          ? `${clean} requested from ${agentName}`
          : `${clean} queued for ${agentName}`,
        "success"
      );
      setInstruct("");
    } catch (err) {
      if (err instanceof AuthError) {
        onAuthLost();
        return;
      }
      toast.push(
        err instanceof Error ? err.message : "Request failed",
        "error"
      );
    } finally {
      setRequesting(false);
    }
  }

  async function onCopy() {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(doc.content);
      toast.push("Copied to clipboard", "success");
    } catch {
      toast.push("Copy failed — your browser blocked clipboard access", "error");
    }
  }

  const visibleFiles = useMemo(() => selectDocuments(files ?? [], filter, includeSupporting, sort), [files, filter, includeSupporting, sort]);
  const supportingCount = files?.filter((file) => isSupportingDocument(file.path)).length ?? 0;
  useEffect(() => setShown(12), [filter, includeSupporting, sort]);

  const navigationNotice = openError ? (
    <div className="form-error" role="alert">
      <p><strong>{documentTitle(openError.path)}</strong>: {openError.message}</p>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
        if (openError.artifact) { lastOpenRequest.current = null; void loadList(false); }
        else if (workspaceDocumentPath(openError.path)) void openPath(openError.path);
        else { setOpenError(null); void loadList(false); }
      }}>Try again</button>
    </div>
  ) : openingPath ? <p className="muted" role="status">Opening {documentTitle(openingPath)}…</p> : null;

  return (
    <section className="card md-ws doc-workspace" aria-label="Agent documents">
      <div className="feed__head">
        <div><h2>Documents</h2><p className="muted doc-intro">Reports and Markdown files appear here automatically.</p></div>
        <button type="button" className="btn btn--ghost btn--sm" disabled={refreshing} onClick={() => void loadList(false)}>{refreshing ? "Refreshing…" : "Refresh"}</button>
      </div>
      {!doc ? navigationNotice : null}
      {listError ? <p className="form-error" role="alert">{listError}</p> : null}
      {pending ? <div className="md-ws__waiting" role="status">
        <p>Waiting for <strong>{pending.path}</strong> · {formatElapsed(pending.startedAt, now)}</p>
        <p className="muted">{agentStatus === "offline" ? "The agent is offline. Tracking resumes when it reconnects." : "The request may be queued behind other work. We check every 5 seconds and open the updated file when it is ready."}</p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPending(null)}>Dismiss tracking</button>
      </div> : null}
      <div className={"md-ws__panes" + (doc ? " doc-panes--reading" : " doc-panes--browse")}>
        <div className="md-ws__list">
          <div className="doc-filters">
            <input type="search" className="md-ws__filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search documents…" autoComplete="off" aria-label="Search documents" />
            <select aria-label="Sort documents" value={sort} onChange={(e) => setSort(e.target.value as "recommended" | "recent" | "name")}><option value="recommended">Recommended</option><option value="recent">Recently updated</option><option value="name">Name A–Z</option></select>
          </div>
          <div className="doc-list-options">
            <span className="muted">{files === null ? "Loading…" : `${visibleFiles.length} document${visibleFiles.length === 1 ? "" : "s"}`}</span>
            {supportingCount > 0 ? <label><input type="checkbox" checked={includeSupporting} onChange={(e) => setIncludeSupporting(e.target.checked)} /> Include supporting files ({supportingCount})</label> : null}
          </div>
          {filter.trim() ? <p className="muted doc-search-hint">Search includes all discovered files.</p> : null}
          {files === null ? <div className="skeleton-stack"><div className="skeleton" /><div className="skeleton" /></div>
            : visibleFiles.length === 0 ? <p className="muted md-ws__none">{files.length === 0 ? "No documents yet. Completed tasks that produce a report will appear here." : "No matching documents. Try another search or include supporting files."}</p>
            : <ul className="md-files doc-files">{visibleFiles.slice(0, shown).map((file) => <li key={file.path}>
              <button type="button" className={"md-file" + (doc?.path === file.path ? " md-file--active" : "")} aria-pressed={doc?.path === file.path} disabled={openingPath !== null} onClick={() => void openPath(file.path)}>
                <span className="md-file__name">{openingPath === file.path ? "Opening…" : documentTitle(file.path)}</span>
                <span className="doc-file-path" title={file.path}>{file.path}</span>
                <span className="md-file__meta">{formatRelative(file.mtime)} · {formatBytes(file.bytes)}</span>
              </button>
            </li>)}</ul>}
          {visibleFiles.length > shown ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShown((count) => count + 12)}>Show 12 more · {visibleFiles.length - shown} remaining</button> : null}
          {files && files.length >= 200 ? <p className="muted doc-search-hint">Showing up to 200 documents, prioritizing reports and recent files. Use a more specific workspace folder to discover other documents.</p> : null}
        </div>
        {doc && active ? <MarkdownReader key={doc.path} agentId={agentId} navigationNotice={navigationNotice} doc={doc} cwd={cwd} onCopy={() => void onCopy()} onBack={() => { openSequence.current++; setDoc(null); window.requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })); }} onOpenDocument={(path) => void openPath(path)} /> : null}
      </div>
      <details className="doc-create">
        <summary>Request a document</summary>
        <form className="md-ws__ask" onSubmit={(e) => void onRequest("queue", e)}>
          <p className="muted">Need something specific? Ask {agentName} to write it here.</p>
          <label className="field"><span>File name</span><input value={reqPath} onChange={(e) => setReqPath(e.target.value)} placeholder="reports/summary.md" autoComplete="off" disabled={requesting || pending !== null} /></label>
          <label className="field"><span>What should it contain?</span><textarea className="message-box__input" value={instruct} onChange={(e) => setInstruct(e.target.value)} placeholder="Summarize the results, decisions, and next steps…" rows={3} disabled={requesting || pending !== null} /></label>
          <button className="btn btn--queue" type="submit" disabled={agentStatus === "offline" || requesting || pending !== null || !reqPath.trim()}>{requesting ? "Requesting…" : agentStatus === "running" ? "Queue document request" : "Request document"}</button>
          <p className="muted doc-search-hint">{agentStatus === "offline" ? "Reconnect the worker to request a document." : "This runs after any work already in progress."}</p>
        </form>
      </details>
      {cwd ? <details className="doc-location"><summary>Workspace location</summary><p className="md-ws__root"><code>{cwd}</code></p></details> : null}
    </section>
  );
}
