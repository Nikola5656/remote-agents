import { ProviderFilter } from "../components/ProviderFilter";
import { useProviderSelection } from "../provider-selection";
import { FleetSummary } from "../components/FleetSummary";
import { Link } from "react-router-dom";
import { AgentCard } from "../components/AgentCard";
import { resolveAgentProvider } from "../execution";
import { liveModeLabel, mergeAgentLists } from "../format";
import { useNow } from "../hooks";
import { useLive } from "../live";

export function Agents() {
  const { agents, mode, error } = useLive();
  const list = mergeAgentLists(agents);
  const [filter, setFilter] = useProviderSelection();
  const filtered = list.filter(
    (a) => filter === "all" || resolveAgentProvider(a) === filter
  );
  const anyRunning = list.some(
    (a) => a.status === "running" || a.status === "starting"
  );
  const now = useNow(1000, anyRunning);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="eyebrow">Fleet</p>
          <h1>Agents</h1>
        </div>
        <span className={`live-dot live-dot--${mode}`}>{liveModeLabel(mode)}</span>
      </header>
      {error ? <p className="banner banner--warn">{error}</p> : null}
      <p className="muted">
        Tap an agent to watch it live, send instructions, and read its files.
      </p>
      <FleetSummary agents={list} />
      <ProviderFilter agents={list} value={filter} onChange={setFilter} />
      <section className="cards">
        {filtered.map((agent) => (
          <AgentCard key={agent.id} agent={agent} now={now} />
        ))}
      </section>
      <p className="muted">
        Grow your team.{" "}
        <Link className="text-link" to="/overview">
          Add an agent
        </Link>
      </p>
    </div>
  );
}
