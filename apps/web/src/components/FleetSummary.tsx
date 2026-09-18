import type { AgentSnapshot } from "@remote-agents/shared";
import { fleetCounts } from "../execution";

export function FleetSummary({ agents }: { agents: AgentSnapshot[] }) {
  const counts = fleetCounts(agents);

  return (
    <section className="fleet-summary" aria-label="Fleet status">
      <div>
        <span className="fleet-summary__dot" />
        <strong>{counts.running}</strong>
        <span>Running</span>
      </div>
      <div>
        <strong>{counts.connecting}</strong>
        <span>Connecting</span>
      </div>
      <div>
        <strong>{counts.queued}</strong>
        <span>Queued</span>
      </div>
      <div>
        <strong>{counts.ready}</strong>
        <span>Ready</span>
      </div>
      <div>
        <strong>{counts.instructionsQueued}</strong>
        <span>Waiting</span>
      </div>
      {counts.attention > 0 ? (
        <p className="fleet-summary__attention">
          {counts.attention}{" "}
          {counts.attention === 1 ? "agent needs" : "agents need"} attention
        </p>
      ) : null}
    </section>
  );
}
