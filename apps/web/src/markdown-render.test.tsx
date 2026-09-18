import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MarkdownRenderBoundary } from "./components/MarkdownRenderBoundary.js";
import { MarkdownViewer } from "./components/MarkdownViewer.js";

function Response({ fail, text }: { fail: boolean; text: string }) {
  if (fail) throw new Error("Simulated Markdown renderer failure");
  return <p>{text}</p>;
}

function suppressExpectedReactError(run: () => void) {
  const previous = console.error;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("The above error occurred in the <Response> component")) return;
    previous(...args);
  };
  try { run(); } finally { console.error = previous; }
}

test("a failing document preserves reader controls and exposes the complete original Markdown", () => {
  const source = "# Saved report\n\nThe original contents remain readable.";
  let root!: ReactTestRenderer;
  suppressExpectedReactError(() => act(() => {
    root = create(<section><button>Back to documents</button><MarkdownRenderBoundary source={source}><Response fail text="unused" /></MarkdownRenderBoundary></section>);
  }));
  assert.equal(root.root.findByType("button").children[0], "Back to documents");
  assert.equal(root.root.findByType("pre").children[0], source);
  assert.match(String(root.root.findByProps({ role: "status" }).children[0]), /Formatting is unavailable/);
  act(() => root.unmount());
});

test("a streaming response failure cannot unmount an open document and recovers on new content", () => {
  let root!: ReactTestRenderer;
  const screen = (fail: boolean, text: string) => <main>
    <div hidden><MarkdownRenderBoundary source={text}><Response fail={fail} text={text} /></MarkdownRenderBoundary></div>
    <article><h1>Open document</h1><MarkdownViewer source={"# Useful report\n\nStill readable."} /></article>
  </main>;
  act(() => { root = create(screen(false, "First response")); });
  suppressExpectedReactError(() => act(() => root.update(screen(true, "New response"))));
  assert.equal(root.root.findByType("article").findByType("p").children[0], "Still readable.");
  assert.equal(root.root.findByType("pre").children[0], "New response");
  act(() => root.update(screen(false, "Recovered response")));
  assert.equal(root.root.findAllByType("pre").length, 0);
  assert.ok(root.root.findAllByType("p").some((node) => node.children[0] === "Recovered response"));
  act(() => root.unmount());
});

test("shared Markdown rendering keeps GFM tables and links functional", () => {
  let root!: ReactTestRenderer;
  const links: string[] = [];
  act(() => {
    root = create(<MarkdownViewer source={"| Name | State |\n| --- | --- |\n| Test | Ready |\n\n[Report](reports/result.md)"} onDocumentLink={(href) => { links.push(href); return true; }} />);
  });
  assert.equal(root.root.findAllByType("table").length, 1);
  let prevented = false;
  root.root.findByType("a").props.onClick({ preventDefault() { prevented = true; } });
  assert.deepEqual(links, ["reports/result.md"]);
  assert.equal(prevented, true);
  act(() => root.unmount());
});

test("report anchors support copy link, middle-click and modified click without filesystem URLs", () => {
  let root!: ReactTestRenderer;
  const opened: string[] = [];
  const localPath = "/home/operator/project/reports/result.md";
  act(() => { root = create(<MarkdownViewer source={`[Report](${localPath})`} documentContext={{ agentId: "claude-fable-5", cwd: "/home/operator/project" }} onDocumentLink={(href) => { opened.push(href); return true; }} />); });
  const link = root.root.findByType("a");
  assert.equal(link.props.href, "/agents/claude-fable-5/documents?path=reports%2Fresult.md");
  assert.equal(link.props.target, undefined);
  let prevented = false;
  link.props.onClick({ metaKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(opened.length, 0);
  link.props.onClick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(opened, [localPath]);
  // Auxiliary clicks have no interception: the genuine href is the native destination.
  assert.equal(link.props.onAuxClick, undefined);
  act(() => root.update(<MarkdownViewer source="[File report](file:///home/operator/project/reports/result.md)" documentContext={{ agentId: "claude-fable-5", cwd: "/home/operator/project" }} />));
  assert.equal(root.root.findByType("a").props.href, "/agents/claude-fable-5/documents?path=reports%2Fresult.md");
  act(() => root.unmount());
});

test("external report URLs retain normal browser navigation", () => {
  let root!: ReactTestRenderer;
  let intercepted = false;
  act(() => { root = create(<MarkdownViewer source="[External report](https://example.com/report.md)" documentContext={{ agentId: "agent-1" }} onDocumentLink={() => { intercepted = true; return true; }} />); });
  const link = root.root.findByType("a");
  assert.equal(link.props.href, "https://example.com/report.md");
  let prevented = false;
  link.props.onClick({ preventDefault() { prevented = true; } });
  assert.equal(intercepted, false);
  assert.equal(prevented, false);
  act(() => root.unmount());
});
