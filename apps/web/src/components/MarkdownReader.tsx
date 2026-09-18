import type { WorkspaceFileContent } from "@remote-agents/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { documentTitle, headingAnchors, linkedDocument } from "../documents";
import { openReaderDialog } from "../reader-dialog";
import { formatRelative } from "../format";
import "./documents.css";
import { MarkdownViewer } from "./MarkdownViewer";

type Props = {
  doc: WorkspaceFileContent;
  cwd?: string;
  agentId?: string;
  navigationNotice?: ReactNode;
  onCopy: () => void;
  onBack?: () => void;
  onOpenDocument?: (path: string) => void;
};

export function MarkdownReader({ doc, cwd, agentId, navigationNotice, onCopy, onBack, onOpenDocument }: Props) {
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const [fullWidth, setFullWidth] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [outline, setOutline] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const savedScroll = useRef(0);
  const restoreFocus = useRef(false);
  const readingMinutes = useMemo(() => Math.max(1, Math.ceil(doc.content.trim().split(/\s+/).length / 220)), [doc.content]);

  function toggleFullWidth() {
    savedScroll.current = contentRef.current?.scrollTop || 0;
    restoreFocus.current = fullWidth;
    setFullWidth(!fullWidth);
  }

  function closeReader() {
    if (onBack) onBack();
    else toggleFullWidth();
  }

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = savedScroll.current;
    if (!fullWidth) {
      if (restoreFocus.current) expandRef.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
      return;
    }
    const dialog = dialogRef.current!;
    const closeDialog = openReaderDialog(dialog, document.body);
    if (contentRef.current) contentRef.current.scrollTop = savedScroll.current;
    return closeDialog;
  }, [fullWidth]);

  // Read the rendered headings, so fenced examples and inline formatting cannot
  // create phantom sections.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const read = () => {
      const headings = Array.from(content.querySelectorAll("h1,h2,h3"), (heading) => heading.textContent ?? "");
      setOutline((current) => current.join("\n") === headings.join("\n") ? current : headings);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [doc.content, fullWidth, view]);

  const reader = (
    <div className={`md-viewer doc-reader${fullWidth ? " md-viewer--expanded" : ""}`}>
      <header className="md-viewer__header">
        <div className="doc-reader__navigation">
          {onBack ? <button type="button" className="btn btn--ghost btn--sm" onClick={closeReader}>← Documents</button> : null}
          <button ref={expandRef} type="button" className="btn btn--ghost btn--sm" aria-label={fullWidth ? "Exit full-screen reader" : "Open full-screen reader"} onClick={toggleFullWidth}>{fullWidth ? "Exit full screen" : "Full screen"}</button>
        </div>
        <h3 className="doc-reader__title">{documentTitle(doc.path)}</h3>
        <p className="md-viewer__meta muted">{readingMinutes} min read · updated {formatRelative(doc.mtime)}</p>
        <div className="doc-reader__tools">
          {outline.length > 1 && view === "rendered" ? <select aria-label="Jump to document section" defaultValue="" onChange={(event) => {
            if (!event.target.value) return;
            contentRef.current?.querySelectorAll("h1,h2,h3")[Number(event.target.value)]?.scrollIntoView({ block: "start" });
            event.target.value = "";
          }}><option value="" disabled>Jump to section…</option>{outline.map((title, index) => <option key={index} value={index}>{title}</option>)}</select> : <span />}
          <details className="doc-reader__options"><summary>Options</summary><div>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setView(view === "rendered" ? "raw" : "rendered")}>{view === "rendered" ? "View Markdown source" : "Read formatted document"}</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onCopy}>Copy document</button>
            <p className="muted doc-file-path">{doc.path}</p>
          </div></details>
        </div>
        {navigationNotice}
      </header>
      <div ref={contentRef} className="md-viewer__content" role="region" aria-label="File contents" tabIndex={0}>
        {view === "rendered" ? <MarkdownViewer documentContext={agentId ? { agentId, cwd, currentPath: doc.path } : undefined} source={doc.content} empty="This file is empty." onDocumentLink={(href) => {
          if (href.startsWith("#")) {
            let anchor: string;
            try { anchor = decodeURIComponent(href.slice(1)); } catch { return true; }
            if (!anchor) { contentRef.current?.scrollTo({ top: 0 }); return true; }
            const headings = Array.from(contentRef.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? []);
            const index = headingAnchors(headings.map((heading) => heading.textContent ?? "")).indexOf(anchor);
            headings[index]?.scrollIntoView({ block: "start" });
            return true;
          }
          if (!onOpenDocument) return false;
          const path = linkedDocument(doc.path, href, cwd);
          if (!path) return false;
          onOpenDocument(path);
          return true;
        }} /> : <pre className="md-raw">{doc.content || "This file is empty."}</pre>}
      </div>
    </div>
  );

  return fullWidth ? createPortal(
    <dialog ref={dialogRef} className="md-dialog" aria-label={`Reading ${doc.path}`} aria-modal="true" style={{ zIndex: 1000 }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeReader();
          return;
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]'
        )).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onCancel={(event) => { event.preventDefault(); closeReader(); }}>
      {reader}
    </dialog>, document.body
  ) : reader;
}
