import type { AgentSnapshot } from "@remote-agents/shared";
import { memo } from "react";
import { Link } from "react-router-dom";
import {
  buildExecutionView,
  displayExecutionModel,
} from "../execution";
import { formatElapsed, formatRelative } from "../format";
import { Icon } from "./Icon";

function footerLine(
  view: ReturnType<typeof buildExecutionView>,
  agent: AgentSnapshot,
  now: number
): string {
  const parts: string[] = [];
  if (view.elapsedMs !== null && agent.runStartedAt) {
    parts.push(`${formatElapsed(agent.runStartedAt, now)} elapsed`);
  }
  if (view.toolCount > 0) {
    parts.push(`${view.toolCount} tools`);
  }
  if (view.isStale && view.lastUpdateMs) {
    parts.push(`stale · ${formatRelative(view.lastUpdateMs, now)}`);
  } else if (view.lastUpdateMs) {
    parts.push(`active ${formatRelative(view.lastUpdateMs, now)}`);
  } else {
    parts.push(`${view.providerLabel} · ${displayExecutionModel(agent.model)}`);
  }
  return parts.join(" · ");
}

export const AgentCard = memo(function AgentCard({ agent, now }: { agent: AgentSnapshot; now: number }) {
  const view = buildExecutionView(agent, now);

  return (
    <Link
      className={`card agent-card agent-card--${view.provider}`}
      to={`/agents/${encodeURIComponent(agent.id)}`}
      aria-label={`${agent.name}, ${displayExecutionModel(agent.model)}, ${view.statusLabel}`}
    >
      <header className="agent-card__head">
        <span
          className={`provider-icon provider-icon--${view.provider}`}
          aria-hidden
        >
          {view.provider === "codex" ? "✳" : view.provider === "claude" ? "◎" : "↗"}
        </span>
        <div className="agent-card__identity">
          <h2 className="agent-card__name">{agent.name}</h2>
          <p className="agent-card__model">
            {view.providerLabel} · {displayExecutionModel(agent.model)}
          </p>
        </div>
        <span className={`status-pill status-pill--${agent.status}`}>
          {view.statusLabel}
        </span>
      </header>
      <p className="agent-card__headline">{view.headline}</p>
      {view.lastActions.length > 0 && view.phase === "running" ? (
        <p className="agent-card__tools muted">
          {view.lastActions.slice(-2).join(" → ")}
        </p>
      ) : null}
      <footer className="agent-card__footer">
        <span>{footerLine(view, agent, now)}</span>
        <span className="agent-card__open">
          Open <Icon name="arrow" />
        </span>
      </footer>
      {agent.queueLength > 0 || agent.claude?.attached ? (
        <div className="agent-card__badges">
          {agent.queueLength > 0 ? (
            <span className="chip chip--queue">
              {agent.queueLength} queued
            </span>
          ) : null}
          {agent.claude?.attached ? (
            <span className="chip">
              Claude {agent.claude.status === "idle" ? "ready" : agent.claude.status}
            </span>
          ) : null}
          {view.isStale ? <span className="chip chip--warn">Stale</span> : null}
        </div>
      ) : null}
    </Link>
  );
});
