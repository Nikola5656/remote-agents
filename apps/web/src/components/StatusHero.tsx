import type { AgentSnapshot } from "@remote-agents/shared";
import { buildExecutionView } from "../execution";
import { formatElapsed, formatRelative } from "../format";

type Props = {
  agent: AgentSnapshot;
  now: number;
  onReviewLastInstruction?: () => void;
};

/** A compact lifecycle summary; the activity feed owns task prose and tool details. */
export function StatusHero({ agent, now, onReviewLastInstruction }: Props) {
  const view = buildExecutionView(agent, now);
  const active = view.phase === "running" || view.phase === "connecting";
  const helpers = agent.subagents?.filter((item) => item.status === "running").length ?? 0;
  const guidance = view.phase === "offline" ? "Worker disconnected. Updates resume when it reconnects."
    : view.phase === "connecting" ? "Starting the session. Activity will appear below."
    : view.phase === "queued" ? "Instruction accepted. Waiting for the agent to start."
    : view.phase === "error" ? "The last task stopped with an error. Review its activity before trying again."
    : view.isStale ? "No recent activity. The task may still be running on the worker."
    : view.phase === "running" ? "Updates arrive automatically as the agent works."
    : agent.headline === "Cancelled" ? "Task stopped. Review the activity before sending your next instruction."
    : agent.runId ? "Ready for your next task. The last response and documents are available below."
    : "Ready for a task. Send an instruction below.";
  return (
    <section className={`run-summary${view.isStale || view.phase === "error" ? " run-summary--attention" : ""}`} aria-label="Task status">
      <div className="run-summary__meta">
        <span className={`status-pill status-pill--${agent.status}`}>{view.statusLabel}</span>
        {active && agent.runStartedAt ? <span>{formatElapsed(agent.runStartedAt, now)} elapsed</span> : null}
        {view.toolCount > 0 ? <span>{view.toolCount} action{view.toolCount === 1 ? "" : "s"}</span> : null}
        {helpers > 0 ? <span>{helpers} helper{helpers === 1 ? "" : "s"} working</span> : null}
        {active && view.lastUpdateMs ? <span className="run-summary__updated">Updated {formatRelative(view.lastUpdateMs, now)}</span> : null}
      </div>
      <p role="status">{guidance}</p>
      {view.phase === "error" && onReviewLastInstruction ? <button type="button" className="btn btn--ghost btn--sm" onClick={onReviewLastInstruction}>Review last instruction</button> : null}
    </section>
  );
}
