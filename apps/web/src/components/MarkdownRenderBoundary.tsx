import { Component, type ReactNode } from "react";

type Props = {
  source: string;
  children: ReactNode;
};

/** A document or streamed response must never take the rest of the app down. */
export class MarkdownRenderBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: Props, previousState: { failed: boolean }) {
    if (this.state.failed && previousState.failed && previous.source !== this.props.source) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="md-render-fallback">
        <p className="muted" role="status">
          Formatting is unavailable. You can still read and copy the original Markdown below.
        </p>
        <pre className="md-raw">{this.props.source || "This document is empty."}</pre>
      </div>
    );
  }
}
