import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { AgentSnapshot } from "@remote-agents/shared";
import { AuthError, fetchAgent } from "../api";
import { useAuth } from "../auth";
import { MarkdownWorkspace } from "../components/MarkdownWorkspace";
import { useLive } from "../live";

/** A durable destination for shared report links and native open-in-new-tab. */
export function AgentDocuments() {
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const { agents } = useLive();
  const { markSignedOut } = useAuth();
  const [loaded, setLoaded] = useState<AgentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agent = agents.find((item) => item.id === id) ?? (loaded?.id === id ? loaded : null);
  const path = search.get("path");
  const artifact = search.get("artifact");
  const request = useMemo(() => path ? { path } : artifact ? { artifact } : null, [path, artifact]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void fetchAgent(id).then((snapshot) => { if (!cancelled) setLoaded(snapshot); }).catch((failure) => {
      if (failure instanceof AuthError) markSignedOut();
      else if (!cancelled) setError("This agent is unavailable. Return to the agents page and try again.");
    });
    return () => { cancelled = true; };
  }, [id, markSignedOut]);

  return (
    <div className="page">
      <header className="page__head"><div>
        <Link to={`/agents/${encodeURIComponent(id)}`}>← Back to {agent?.name ?? "agent"}</Link>
        <h1>{agent?.name ? `${agent.name} documents` : "Documents"}</h1>
      </div></header>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {agent ? <MarkdownWorkspace key={`${agent.id}:${agent.cwd}`} agentId={agent.id} agentName={agent.name}
        agentStatus={agent.status} cwd={agent.cwd} openRequest={request} onAuthLost={markSignedOut} />
        : !error ? <p className="muted" role="status">Loading documents…</p> : null}
    </div>
  );
}
