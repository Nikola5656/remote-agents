import { ProviderFilter } from "../components/ProviderFilter";
import { useProviderSelection } from "../provider-selection";
import type { ModelOption } from "@remote-agents/shared";
import { MODEL_CATALOG } from "@remote-agents/shared";
import { FormEvent, useEffect, useState } from "react";
import { resolveAgentProvider } from "../execution";
import { FleetSummary } from "../components/FleetSummary";
import { AgentCard } from "../components/AgentCard";
import { AuthError, spawnAgent, fetchModels } from "../api";
import { useAuth } from "../auth";
import { isAgentSnapshot, liveModeLabel, mergeAgentLists } from "../format";
import { useNow } from "../hooks";
import { useLive } from "../live";
import { useToast } from "../toast";

export function Overview() {
  const { agents, mode, error, refresh, replaceAgent } = useLive();
  const { markSignedOut } = useAuth();
  const toast = useToast();
  const list = mergeAgentLists(agents);
  const [filter, setFilter] = useProviderSelection();
  const groups = [
    {provider: "codex", title: "Codex agents", detail: "Astra & Sol · Medium reasoning"},
    {provider: "claude", title: "Claude Code agents", detail: "Fable & Opus · Native Claude sessions"},
    {provider: "cursor", title: "Cursor agents", detail: "Your connected Cursor agents"},
  ].map(group => ({...group, agents: list.filter(agent => resolveAgentProvider(agent) === group.provider)}))
    .filter(group => group.agents.length > 0 && (filter === "all" || group.provider === filter));
  const anyRunning = list.some(
    (a) => a.status === "running" || a.status === "starting"
  );
  const now = useNow(1000, anyRunning);

  const [models, setModels] = useState<ModelOption[]>(MODEL_CATALOG);
  const [name, setName] = useState("");
  const [model, setModel] = useState(MODEL_CATALOG[0]?.id ?? "auto");
  const [cwd, setCwd] = useState("");
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchModels()
      .then((next) => {
        if (!cancelled && next.length) {
          setModels(next);
          setModel((prev) => (next.some((m) => m.id === prev) ? prev : next[0].id));
        }
      })
      .catch((err) => {
        if (err instanceof AuthError) markSignedOut();
      });
    return () => {
      cancelled = true;
    };
  }, [markSignedOut]);

  async function onSpawn(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !model) {
      setSpawnError("Name and model are required.");
      return;
    }
    setSpawning(true);
    setSpawnError(null);
    try {
      const next = await spawnAgent({
        name: name.trim(),
        model,
        cwd: cwd.trim() || undefined,
      });
      if (isAgentSnapshot(next)) replaceAgent(next);
      else await refresh();
      toast.push(`${name.trim()} is ready`, "success");
      setName("");
      setCwd("");
    } catch (err) {
      if (err instanceof AuthError) {
        markSignedOut();
        return;
      }
      setSpawnError(err instanceof Error ? err.message : "Could not spawn agent");
    } finally {
      setSpawning(false);
    }
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="eyebrow">Your workspace, anywhere</p>
          <h1>Mission control</h1>
        </div>
        <span className={`live-dot live-dot--${mode}`}>{liveModeLabel(mode)}</span>
      </header>

      {error ? <p className="banner banner--warn">{error}</p> : null}

      <p className="page-lede">Run tasks, follow progress, and pick up where you left off.</p>
      <FleetSummary agents={list} />
      <ProviderFilter agents={list} value={filter} onChange={setFilter} />
      {groups.map((group) => (
        <section className="section" key={group.title}>
          <div className="section-heading"><div><h2>{group.title} <span className="section-count">{group.agents.length}</span></h2><p className="muted">{group.detail}</p></div></div>
          {group.agents.length ? <div className="cards">{group.agents.map((agent) => <AgentCard key={agent.id} agent={agent} now={now}/>)}</div> : <p className="card muted">Waiting for the worker to connect your agents.</p>}
        </section>
      ))}

      <details className="card acc" id="new-agent">
        <summary className="acc__summary">
          <span>Add an agent</span>
          <span className="muted acc__hint">Cursor, Codex or Claude</span>
        </summary>
        <div className="acc__body">
          <form className="spawn__form" onSubmit={(e) => void onSpawn(e)}>
            <label className="field">
              <span>Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Research"
                autoComplete="off"
                required
              />
            </label>
            <label className="field">
              <span>Model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Working folder (optional)</span>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="Leave empty for a separate workspace"
                autoComplete="off"
              />
            </label>
            {spawnError ? <p className="form-error">{spawnError}</p> : null}
            <button className="btn btn--accent" type="submit" disabled={spawning}>
              {spawning ? "Creating…" : "Create agent"}
            </button>
          </form>
        </div>
      </details>
    </div>
  );
}
