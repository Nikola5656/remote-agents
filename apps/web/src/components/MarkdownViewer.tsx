import { memo } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { documentAppHref, type DocumentContext } from "../documents.js";
import { MarkdownRenderBoundary } from "./MarkdownRenderBoundary.js";

type Props = {
  source: string;
  documentContext?: DocumentContext;
  empty?: string;
  onDocumentLink?: (href: string) => boolean;
};

export const MarkdownViewer = memo(function MarkdownViewer(props: Props) {
  return (
    <MarkdownRenderBoundary source={props.source}>
      <MarkdownContent {...props} />
    </MarkdownRenderBoundary>
  );
});

function MarkdownContent({
  source,
  empty = "No markdown.",
  onDocumentLink,
  documentContext,
}: Props) {
  if (!source.trim()) return <p className="muted">{empty}</p>;
  return (
    <div className="md-view">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => documentContext && key === "href" && documentAppHref(documentContext, url)
          ? url
          : defaultUrlTransform(url)}
        components={{
          table: ({ children }) => (
            <div className="md-table-scroll" role="region" aria-label="Table, scroll horizontally" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => <pre className="md-code" tabIndex={0}>{children}</pre>,
          a: ({ href, children }) => {
            const appHref = href && documentContext ? documentAppHref(documentContext, href) : null;
            return (
              <a href={appHref ?? href} target={appHref || href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer" onClick={(event) => {
                if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && href && (!documentContext || appHref || href.startsWith("#")) && onDocumentLink?.(href)) event.preventDefault();
              }}>{children}</a>
            );
          },
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
