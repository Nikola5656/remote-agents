import { useEffect, useState } from "react";
import { useLive } from "../live";
import {
  mergeAgentLists,
  agentWithModel,
  formatRelative,
  formatUptime,
  liveModeLabel,
  overallHealth,
  statusLabel,
} from "../format";

export function Health() {
  const { health, agents, mode, error } = useLive();
  const [now, setNow] = useState(Date.now());
  const overall = overallHealth(health);
  const cores = mergeAgentLists(agents).map(agent => ({...agent, present: health.workerConnected && agent.status !== "offline"}));
  const coresOk = cores.every((c) => c.present);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="eyebrow">Connected & ready</p>
          <h1>Health</h1>
        </div>
        <span className={`live-dot live-dot--${mode}`}>{liveModeLabel(mode)}</span>
      </header>

      {error ? <p className="banner banner--warn">{error}</p> : null}

      <section className={`health-hero health-hero--${overall}`}>
        <p className="health-hero__label">Status</p>
        <p className="health-hero__value">
          {overall === "ok" ? "All systems ready" : overall === "degraded" ? "Needs attention" : "Worker offline"}
        </p>
        <p className="health-hero__detail">
          {overall === "ok"
            ? "Worker linked. Agents are available."
            : overall === "degraded"
              ? "Worker linked. One or more checks need action."
              : "Worker not connected."}
        </p>
      </section>

      <section className="stack">
        <article className="card check">
          <div className="check__row">
            <h2>Worker</h2>
            <span className={health.workerConnected ? "ok-text" : "bad-text"}>
              {health.workerConnected ? "LINKED" : "NO LINK"}
            </span>
          </div>
          <p className="muted">
            Last heartbeat {formatRelative(health.lastHeartbeatAt, now)}
            {health.lastHeartbeatAt
              ? ` · ${new Date(health.lastHeartbeatAt).toLocaleTimeString()}`
              : ""}
          </p>
          <p className="muted">
            {health.host.hostname} · {health.host.platform} · up{" "}
            {formatUptime(health.host.uptimeSec)}
          </p>
        </article>

        <article className="card check">
          <div className="check__row">
            <h2>Sleep prevention</h2>
            <span
              className={
                health.keepAwake.preventingSleep ? "ok-text" : "warn-text"
              }
            >
              {health.keepAwake.preventingSleep ? "HOLD" : "SLEEP"}
            </span>
          </div>
          <p className="muted">
            caffeinate {health.keepAwake.caffeinate ? "on" : "off"}
            {health.keepAwake.detail ? ` · ${health.keepAwake.detail}` : ""}
          </p>
        </article>

        <article className="card check">
          <div className="check__row">
            <h2>Cursor agents</h2>
            <span className={health.cursorSdk.ready ? "ok-text" : "bad-text"}>
              {health.cursorSdk.ready ? "READY" : "MISSING"}
            </span>
          </div>
          <p className="muted">
            API key {health.cursorSdk.apiKeyPresent ? "present" : "missing"}
            {health.cursorSdk.detail ? ` · ${health.cursorSdk.detail}` : ""}
          </p>
        </article>

        <article className="card check">
          <div className="check__row"><h2>Codex agents</h2><span className={health.codex?.ready ? "ok-text" : "warn-text"}>{health.codex?.ready ? "READY" : "UNAVAILABLE"}</span></div>
          <p className="muted">{health.codex?.detail || "Waiting for Codex worker status"}</p>
        </article>
        <article className="card check">
          <div className="check__row">
            <h2>Claude Code</h2>
            <span className={health.claude.available ? "ok-text" : "warn-text"}>
              {health.claude.available ? "READY" : "OFFLINE"}
            </span>
          </div>
          <p className="muted">{health.claude.detail || "No detail"}</p>
        </article>

        <article className="card check">
          <div className="check__row">
            <h2>Agent fleet</h2>
            <span className={coresOk ? "ok-text" : "bad-text"}>
              {cores.filter((c) => c.present).length}/{cores.length} present
            </span>
          </div>
          <ul className="core-list">
            {cores.map((core) => (
              <li key={core.id}>
                <span className={core.present ? "ok-text" : "bad-text"}>
                  {core.present ? "●" : "○"}
                </span>
                {agentWithModel(core.name, core.model)}
                <span className="muted">{statusLabel(core.status)}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="card check">
          <div className="check__row">
            <h2>Issues</h2>
            <span className={health.issues.length ? "warn-text" : "ok-text"}>
              {health.issues.length === 0 ? "CLEAR" : `${health.issues.length}`}
            </span>
          </div>
          {health.issues.length === 0 ? (
            <p className="muted">No issues.</p>
          ) : (
            <ul className="issue-list">
              {health.issues.map((issue, i) => (
                <li key={`${issue}-${i}`}>{issue}</li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </div>
  );
}
