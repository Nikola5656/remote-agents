import type {
  AgentSnapshot,
  DeliveryMode,
  ModelOption,
  OutputMode,
} from "@remote-agents/shared";
import { MODEL_CATALOG, modelLabel, modelProvider } from "@remote-agents/shared";
import {
  buildExecutionView,
  displayExecutionModel,
  providerLabel,
  resolveAgentProvider,
} from "../execution";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ActivityFeed } from "../components/ActivityFeed";
import { MarkdownWorkspace } from "../components/MarkdownWorkspace";
import { MessageBox } from "../components/MessageBox";
import { StatusHero } from "../components/StatusHero";
import {
  AuthError,
  fetchAgent,
  fetchModels,
  sendAgentMessage,
  stopAgent,
  removeQueuedInstruction,
  sendClaudeMessage,
  setAgentCwd,
  setAgentModel,
  setAgentOutputMode,
  stopClaude,
} from "../api";
import { useAuth } from "../auth";
import {
  displayModel,
  formatClock,
  isAgentSnapshot,
  readPrompt,
  rememberPrompt,
  writeLastAgent,
} from "../format";
import { useNow } from "../hooks";
import { useLive } from "../live";
import { useToast } from "../toast";
import { linkedDocument } from "../documents";

import "./agent-detail.css";

const DETAIL_TABS = ["Activity", "Documents", "Settings"] as const;
type DetailTab = typeof DETAIL_TABS[number];

function DetailSkeleton() {
  return (
    <div className="page">
      <div className="skeleton-stack">
        <div className="skeleton skeleton--hero" />
        <div className="skeleton skeleton--block" />
        <div className="skeleton skeleton--block" />
      </div>
    </div>
  );
}

export function AgentDetail() {
  const { id = "" } = useParams();
  const { agents, refresh, replaceAgent } = useLive();
  const { markSignedOut } = useAuth();
  const toast = useToast();
  const fromLive = agents.find((a) => a.id === id);
  const latestAgents = useRef(agents);
  latestAgents.current = agents;
  const currentAgentId = useRef(id);
  currentAgentId.current = id;
  const [models, setModels] = useState<ModelOption[]>(MODEL_CATALOG);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [removingInstruction, setRemovingInstruction] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [cwdDraft, setCwdDraft] = useState("");
  const [pinnedPrompt, setPinnedPrompt] = useState<string | null>(() =>
    id ? readPrompt(id) : null
  );
  const [instructionDraft, setInstructionDraft] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("Activity");
  const [documentRequest, setDocumentRequest] = useState<{ path: string; agentId: string } | null>(null);

  const agent = fromLive;
  const running =
    agent?.status === "running" ||
    agent?.status === "starting" ||
    agent?.status === "queued";
  const now = useNow(running ? 1000 : 15_000);
  const execution = agent ? buildExecutionView(agent, now) : null;

  useEffect(() => {
    if (id) {
      writeLastAgent(id);
      setPinnedPrompt(readPrompt(id));
      setTab("Activity");
      setInstructionDraft(null);
      setDocumentRequest(null);
      setControlError(null);
      setStopping(false);
      setRemovingInstruction(null);
    }
  }, [id]);

  useEffect(() => {
    if (agent?.cwd) setCwdDraft(agent.cwd);
  }, [agent?.cwd]);

  useEffect(() => {
    let cancelled = false;
    if (!id) return;
    setLoadError(null);
    fetchAgent(id)
      .then((next) => {
        if (!cancelled) {
          const current = latestAgents.current.find((item) => item.id === id);
          if (!current || next.updatedAt >= current.updatedAt) replaceAgent(next);
        }
      })
      .catch((err) => {
        if (err instanceof AuthError) markSignedOut();
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Agent unavailable");
      });
    fetchModels()
      .then((next) => {
        if (!cancelled && next.length) setModels(next);
      })
      .catch((err) => {
        if (err instanceof AuthError) markSignedOut();
      });
    return () => {
      cancelled = true;
    };
  }, [id, markSignedOut, replaceAgent]);

  const catalog = useMemo(() => {
    if (!agent) return models;
    const provider = resolveAgentProvider(agent);
    const base = MODEL_CATALOG.filter(
      (entry) =>
        modelProvider(entry.id) === provider ||
        (provider === "claude" && entry.id.startsWith("claude-code:"))
    );
    const merged = [...base, ...models].filter((entry) => modelProvider(entry.id) === provider);
    const extra = (agent.availableModels ?? [])
      .filter((mid) => modelProvider(mid) === provider && !merged.some((entry) => entry.id === mid))
      .map((mid) => ({
        id: mid,
        label: modelLabel(mid),
        short: modelLabel(mid),
      }));
    const seen = new Set<string>();
    return [...merged, ...extra].filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }, [agent, models]);

  function patchAgent(patch: Partial<AgentSnapshot>) {
    const current = latestAgents.current.find((item) => item.id === id);
    if (current) replaceAgent({ ...current, ...patch });
  }

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthError) {
        markSignedOut();
      }
      throw err;
    }
  }

  async function onSend(text: string, delivery: DeliveryMode) {
    if (!agent) return;
    await guarded(async () => {
      await sendAgentMessage(id, text, delivery);
      rememberPrompt(id, text);
      if (currentAgentId.current === id) setPinnedPrompt(text);
      if (delivery === "queue") {
        toast.push(running ? `Queued for ${agent.name}` : `Sent to ${agent.name}`, "success");
      } else {
        toast.push(`Interrupt sent to ${agent.name}`, "success");
      }
      void refresh();
    });
  }

  async function onModel(model: string) {
    if (!agent || !model || model === agent.model) return;
    const prev = agent.model;
    setSettingsBusy(true);
    patchAgent({ model });
    try {
      await guarded(async () => {
        const next = await setAgentModel(id, model);
        if (isAgentSnapshot(next)) {
          patchAgent({ model: next.model });
        }
        toast.push(`Model set to ${displayModel(model)}`, "success");
      });
    } catch (err) {
      patchAgent({ model: prev });
      toast.push(
        err instanceof Error ? err.message : "Model change failed",
        "error"
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  async function onStop() {
    if (!agent?.runId || stopping) return;
    const targetId = agent.id;
    setStopping(true);
    setControlError(null);
    try {
      await guarded(() => stopAgent(targetId, agent.runId!));
      if (currentAgentId.current === targetId) {
        toast.push("Stop accepted. Queued instructions continue after cancellation.", "success");
        void refresh();
      }
    } catch (err) {
      if (currentAgentId.current === targetId) setControlError(err instanceof Error ? err.message : "Could not stop the task");
    } finally {
      if (currentAgentId.current === targetId) setStopping(false);
    }
  }

  async function onRemoveInstruction(instructionId: string) {
    if (!agent || removingInstruction) return;
    const targetId = agent.id;
    setRemovingInstruction(instructionId);
    setControlError(null);
    try {
      await guarded(() => removeQueuedInstruction(targetId, instructionId));
      if (currentAgentId.current === targetId) {
        toast.push("Queued instruction removed", "success");
        void refresh();
      }
    } catch (err) {
      if (currentAgentId.current === targetId) setControlError(err instanceof Error ? err.message : "Could not remove the instruction");
    } finally {
      if (currentAgentId.current === targetId) setRemovingInstruction(null);
    }
  }

  async function onOutputMode(outputMode: OutputMode) {
    if (!agent || outputMode === agent.outputMode) return;
    const prev = agent.outputMode;
    setSettingsBusy(true);
    patchAgent({ outputMode });
    try {
      await guarded(async () => {
        await setAgentOutputMode(id, outputMode);
      });
    } catch (err) {
      patchAgent({ outputMode: prev });
      toast.push(
        err instanceof Error ? err.message : "Could not switch log detail",
        "error"
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  async function onCwd() {
    if (!agent) return;
    const nextCwd = cwdDraft.trim();
    if (!nextCwd || nextCwd === agent.cwd) return;
    setSettingsBusy(true);
    try {
      await guarded(async () => {
        await setAgentCwd(id, nextCwd);
        patchAgent({ cwd: nextCwd });
        if (currentAgentId.current === id) setDocumentRequest(null);
        toast.push(`Folder changed to ${nextCwd}`, "success");
      });
    } catch (err) {
      toast.push(
        err instanceof Error ? err.message : "Folder change failed",
        "error"
      );
    } finally {
      setSettingsBusy(false);
    }
  }

  async function onClaude(text: string, delivery: DeliveryMode) {
    await guarded(async () => {
      await sendClaudeMessage(id, text, delivery);
      toast.push(`Claude Code prompt sent to ${agent?.name ?? "agent"}`, "success");
      void refresh();
    });
  }

  async function onStopClaude(delivery: DeliveryMode) {
    setClaudeBusy(true);
    try {
      await guarded(async () => {
        await stopClaude(id, delivery);
        toast.push("Claude Code stop requested", "success");
        void refresh();
      });
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Stop failed", "error");
    } finally {
      setClaudeBusy(false);
    }
  }

  if (!agent) {
    return loadError ? <div className="page"><h1>Agent unavailable</h1><p role="alert">{loadError}</p><Link to="/agents" className="btn">Back to agents</Link></div> : <DetailSkeleton />;
  }

  function onReviewLastInstruction() {
    const last = agent?.lastInstruction || readPrompt(id);
    if (!last) {
      toast.push("No previous instruction to review", "error");
      return;
    }
    setTab("Activity");
    setInstructionDraft(last);
    toast.push("Last instruction loaded for review", "success");
  }

  return (
    <div className="page page--detail agent-detail">
      <header className="detail-heading">
        <Link to="/agents" className="detail-heading__back" aria-label="All agents">‹</Link>
        <div className="detail-heading__identity">
          <h1>{agent.name}</h1>
          <p>{providerLabel(execution?.provider ?? resolveAgentProvider(agent))} · {displayExecutionModel(agent.model)}</p>
        </div>
      </header>

      <StatusHero agent={agent} now={now} onReviewLastInstruction={onReviewLastInstruction} />
      {agent.status === "running" || agent.status === "starting" ? <div className="detail-stop">
        <button type="button" className="btn btn--interrupt btn--sm" disabled={stopping || !agent.runId} onClick={() => void onStop()}>
          {stopping ? "Stopping…" : "Stop task"}
        </button>
        <span className="muted">{agent.queueLength ? "Stops the current task. Queued instructions continue." : "Stops the current task without sending a new instruction."}</span>
      </div> : null}
      {controlError ? <p className="form-error" role="alert">{controlError}</p> : null}

      <div className="detail-tabs" role="tablist" aria-label="Agent workspace">
        {DETAIL_TABS.map((name, index) => (
          <button key={name} id={`detail-tab-${name}`} role="tab" type="button"
            aria-selected={tab === name} aria-controls={`detail-panel-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % DETAIL_TABS.length
                : event.key === "ArrowLeft" ? (index + DETAIL_TABS.length - 1) % DETAIL_TABS.length
                : event.key === "Home" ? 0 : event.key === "End" ? DETAIL_TABS.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              setTab(DETAIL_TABS[next]);
              document.getElementById(`detail-tab-${DETAIL_TABS[next]}`)?.focus();
            }}>{name}</button>
        ))}
      </div>

      <div className="detail-panel detail-panel--activity" role="tabpanel" id="detail-panel-Activity" aria-labelledby="detail-tab-Activity" hidden={tab !== "Activity"}>
        <ActivityFeed
          key={agent.id}
          condensedLog={agent.condensedLog}
          fullLog={agent.fullLog}
          summary={agent.summary}
          outputMode={agent.outputMode}
          onToggle={(m) => void onOutputMode(m)}
          toggleBusy={settingsBusy}
          pinnedPrompt={agent.lastInstruction || pinnedPrompt}
          running={agent.status === "running" || agent.status === "starting"}
          lastActions={agent.lastActions}
          stale={execution?.isStale}
          lastUpdateAt={execution?.lastUpdateMs ?? undefined}
          now={now}
          runStarted={Boolean(agent.runId)}
          status={agent.status}
          headline={agent.headline}
          documentContext={{ agentId: agent.id, cwd: agent.cwd }}
          onDocumentLink={(href) => {
            const path = linkedDocument("", href, agent.cwd);
            if (!path) return false;
            setDocumentRequest({ path, agentId: agent.id });
            setTab("Documents");
            return true;
          }}
        />

        <div className="detail-actions">
          <section className="card detail-compose" aria-label="Send an instruction">
            <h2>{running ? "Send a follow-up" : "What should we work on?"}</h2>
            <MessageBox key={agent.id} running={Boolean(running)} disabled={agent.status === "offline"}
              draft={instructionDraft} onSend={onSend} placeholder={`Tell ${agent.name} what to do…`} />
            <p className="detail-compose__hint">
              {agent.status === "offline" ? "Reconnect the worker to send an instruction."
                : running ? "Follow-ups wait for the current task. Interrupt only when you want to change direction now."
                : "Starts in your workspace. Reports appear automatically in Documents."}
            </p>
          </section>

          {agent.queueLength > 0 ? (
            <details className="card acc detail-queue">
              <summary className="acc__summary">{agent.queueLength} instruction{agent.queueLength === 1 ? "" : "s"} waiting</summary>
              <div className="acc__body">
                <ol className="queue-list">
                  {agent.queue.map((item, index) => <li key={item.id}>
                    <div className="detail-queue__item"><span className="muted">Accepted {formatClock(item.createdAt)}</span>
                      <button type="button" className="btn btn--ghost btn--sm" aria-label={`Remove queued instruction ${index + 1}`} disabled={Boolean(removingInstruction) || agent.status === "offline"} onClick={() => void onRemoveInstruction(item.id)}>
                        {removingInstruction === item.id ? "Removing…" : "Remove"}
                      </button>
                    </div><p>{item.text}</p>
                  </li>)}
                </ol>
                <p className="muted queue-note">These run in order after the current task. Interrupting does not clear this queue.</p>
              </div>
            </details>
          ) : null}
        </div>
      </div>

      <div className="detail-panel" role="tabpanel" id="detail-panel-Documents" aria-labelledby="detail-tab-Documents" hidden={tab !== "Documents"}>
        <MarkdownWorkspace key={`${agent.id}:${agent.cwd}`} agentId={agent.id} agentName={agent.name}
          agentStatus={agent.status} cwd={agent.cwd} active={tab === "Documents"} openRequest={documentRequest?.agentId === agent.id ? documentRequest : null} onAuthLost={markSignedOut} />
      </div>

      <div className="detail-panel detail-settings" role="tabpanel" id="detail-panel-Settings" aria-labelledby="detail-tab-Settings" hidden={tab !== "Settings"}>
        <section className="card detail-settings__section">
          <h2>Model</h2>
          <p className="muted">Choose the model for this agent’s next task.</p>
          <label className="field"><span>Model</span>
            <select value={agent.model} disabled={settingsBusy || agent.status === "offline"} onChange={(e) => void onModel(e.target.value)}>
              {catalog.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
              {catalog.some((m) => m.id === agent.model) ? null : <option value={agent.model}>{displayModel(agent.model)}</option>}
            </select>
          </label>
        </section>

        <section className="card detail-settings__section">
          <h2>Workspace folder</h2>
          <p className="muted">{running ? "Changing folder stops the current task. Queued instructions continue in the new folder." : "Tasks start here. The agent can also work in other folders accessible to the worker."}</p>
          <label className="field"><span>Folder path</span>
            <input value={cwdDraft} onChange={(e) => setCwdDraft(e.target.value)} placeholder="~/code/my-project" autoComplete="off" disabled={settingsBusy} />
          </label>
          <button type="button" className="btn btn--accent" disabled={settingsBusy || agent.status === "offline" || !cwdDraft.trim() || cwdDraft.trim() === agent.cwd} onClick={() => void onCwd()}>
            {settingsBusy ? "Saving…" : running ? "Stop task & change folder" : "Save folder"}
          </button>
        </section>

        <details className="card acc">
          <summary className="acc__summary">Additional Claude helper{agent.claude?.attached ? " · active" : ""}</summary>
          <div className="acc__body detail-settings__section">
            <p className="muted">An optional separate helper. Starts only when you send it an instruction.</p>
            {agent.claude?.attached ? <p>{agent.claude.headline || "Helper attached"}</p> : null}
            <MessageBox placeholder="Instruction for the helper…" running={agent.claude?.status === "running"} disabled={agent.status === "offline"} onSend={onClaude} />
            {agent.claude?.attached ? <div className="message-box__actions">
              <button type="button" className="btn btn--ghost" disabled={claudeBusy} onClick={() => void onStopClaude("queue")}>Stop after task</button>
              <button type="button" className="btn btn--interrupt" disabled={claudeBusy} onClick={() => void onStopClaude("interrupt")}>Stop now</button>
            </div> : null}
          </div>
        </details>
        {agent.runId ? <details className="card acc">
          <summary className="acc__summary">Run details</summary>
          <div className="acc__body"><p className="muted">Run identifier</p><code className="detail-run-id">{agent.runId}</code></div>
        </details> : null}
      </div>
    </div>
  );
}
