import type { AgentStatus, OutputMode } from "@remote-agents/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { activityResponse, activitySteps, currentActivityTranscript, describeAction, parseActivityTranscript } from "../activity";
import type { DocumentContext } from "../documents";
import { formatRelative } from "../format";
import "./activity.css";

import { MarkdownViewer } from "./MarkdownViewer";

type Props = {
  condensedLog: string;
  fullLog: string;
  summary: string;
  outputMode: OutputMode;
  onToggle: (mode: OutputMode) => void;
  toggleBusy?: boolean;
  pinnedPrompt: string | null;
  running: boolean;
  runStarted?: boolean;
  lastActions?: string[];
  stale?: boolean;
  lastUpdateAt?: number;
  now?: number;
  status?: AgentStatus;
  headline?: string;
  documentContext?: DocumentContext;
  onDocumentLink?: (href: string) => boolean;
};

export function ActivityFeed({
  condensedLog, fullLog, summary, outputMode, onToggle, toggleBusy,
  pinnedPrompt, running, runStarted = false, lastActions = [], stale = false,
  lastUpdateAt, now = Date.now(), status, headline, onDocumentLink, documentContext,
}: Props) {
  const boxRef = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const [expandResponse, setExpandResponse] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [showThoughts, setShowThoughts] = useState(false);
  const log = fullLog || condensedLog;
  const entries = useMemo(() => parseActivityTranscript(currentActivityTranscript(fullLog, pinnedPrompt, running, runStarted)), [fullLog, pinnedPrompt, running, runStarted]);
  const response = useMemo(() => activityResponse(entries, pinnedPrompt), [entries, pinnedPrompt]);
  const thoughts = useMemo(() => entries.filter((entry) => entry.kind === "thinking"), [entries]);
  const steps = useMemo(() => {
    const recorded = activitySteps(entries);
    return recorded.length ? recorded : lastActions.map((action) => describeAction(action));
  }, [entries, lastActions]);
  const visibleSteps = showAllSteps ? steps : steps.slice(-4);
  const latestResponse = response.latest || (!fullLog && !pinnedPrompt ? summary || condensedLog : "");
  const longResponse = latestResponse.length > 1400 || latestResponse.split("\n").length > 18;

  useEffect(() => {
    const el = boxRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [log, follow, outputMode]);

  function onScroll() {
    const el = boxRef.current;
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  }

  function jumpToLatest() {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
  }

  return (
    <section className="card feed activity-feed" aria-label="Agent activity">
      <div className="feed__head">
        <div>
          <h2>Activity</h2>
          {lastUpdateAt ? <p className="activity-feed__updated muted">Updated {formatRelative(lastUpdateAt, now)}</p> : null}
        </div>
        <div className="segment segment--sm" role="group" aria-label="Activity detail">
          <button type="button" className={outputMode === "condensed" ? "is-on" : ""}
            aria-pressed={outputMode === "condensed"} onClick={() => onToggle("condensed")} disabled={toggleBusy}>Summary</button>
          <button type="button" className={outputMode === "full" ? "is-on" : ""}
            aria-pressed={outputMode === "full"} onClick={() => onToggle("full")} disabled={toggleBusy}>Full log</button>
        </div>
      </div>

      {stale && running ? (
        <p className="banner banner--warn feed__stale" role="status">
          No new activity {lastUpdateAt ? `for ${Math.max(1, Math.floor((now - lastUpdateAt) / 1000))}s` : "yet"}.
          {" "}The agent is still marked running. You can keep waiting or interrupt below.
        </p>
      ) : null}
      {status === "error" ? <p className="banner banner--danger activity-feed__error" role="alert">{headline || "The agent reported an error. Review the activity before sending another instruction."}</p> : null}

      {pinnedPrompt ? (
        <details className="activity-feed__disclosure activity-feed__instruction">
          <summary>Last instruction sent</summary>
          <p className="activity-feed__prompt">{pinnedPrompt}</p>
        </details>
      ) : null}

      {outputMode === "full" ? (
        <div className="feed__body">
          <div className="activity-feed__log-help">
            <span className="muted">Original transcript · {follow ? "Following latest" : "Scroll paused"}</span>
            <button type="button" className="btn btn--ghost btn--sm"
              onClick={() => follow ? setFollow(false) : jumpToLatest()}>{follow ? "Pause scroll" : "Jump to latest"}</button>
          </div>
          <pre className="log feed__log" ref={boxRef} onScroll={onScroll} tabIndex={0} aria-label="Full activity log">
            {log || (running ? "Waiting for the first update…" : "No activity yet. Send an instruction below.")}
          </pre>
        </div>
      ) : (
        <div className={`activity-feed__summary${running ? "" : " activity-feed__summary--finished"}`}>
          {steps.length ? (
            <div className="activity-feed__steps">
              <h3>Recent steps</h3>
              <ol>
                {visibleSteps.map((step, index) => (
                  <li key={`${showAllSteps ? index : steps.length - visibleSteps.length + index}-${step.detail}`}>
                    <span className={`activity-feed__step-icon${step.completed ? " is-complete" : ""}`} aria-hidden="true">{step.completed ? "✓" : "↗"}</span>
                    {step.detail ? (
                      <details className="activity-feed__step-detail"><summary>{step.title}<span>{step.detail}</span></summary><pre>{step.detail}</pre></details>
                    ) : <span>{step.title}</span>}
                  </li>
                ))}
              </ol>
              {steps.length > 4 ? <button type="button" className="btn btn--ghost btn--sm" aria-expanded={showAllSteps}
                onClick={() => setShowAllSteps(!showAllSteps)}>{showAllSteps ? "Show recent steps" : `View all ${steps.length} steps`}</button> : null}
            </div>
          ) : null}

          {latestResponse ? (
            <div className="activity-feed__response">
              <h3>{running ? "Latest update" : "Last response"}</h3>
              <div className={`activity-feed__response-body${longResponse && !expandResponse ? " is-preview" : ""}`}
                tabIndex={longResponse && !expandResponse ? 0 : undefined}
                role={longResponse && !expandResponse ? "region" : undefined}
                aria-label={longResponse && !expandResponse ? "Response preview, scroll to read more" : undefined}>
                <MarkdownViewer source={latestResponse} onDocumentLink={onDocumentLink} documentContext={documentContext} />
              </div>
              {longResponse ? <button type="button" className="btn btn--ghost btn--sm activity-feed__expand" aria-expanded={expandResponse}
                onClick={() => setExpandResponse(!expandResponse)}>{expandResponse ? "Collapse response" : "Read full response"}</button> : null}
            </div>
          ) : (
            <p className="muted activity-feed__empty" role="status">
              {running ? steps.length ? "Waiting for the agent’s next update. Tool activity appears above." : "Your task is active. Waiting for the first update…" : "No response yet. Send an instruction below to get started."}
            </p>
          )}

          {response.earlier.length ? (
            <details className="activity-feed__disclosure" onToggle={(event) => setShowEarlier(event.currentTarget.open)}><summary>Earlier updates ({response.earlier.length})</summary>
              {showEarlier ? <div className="activity-feed__earlier">{response.earlier.map((entry, index) => <MarkdownViewer key={index} source={entry.text} onDocumentLink={onDocumentLink} documentContext={documentContext} />)}</div> : null}
            </details>
          ) : null}
          {thoughts.length ? (
            <details className="activity-feed__disclosure" onToggle={(event) => setShowThoughts(event.currentTarget.open)}><summary>Reasoning notes ({thoughts.length})</summary>
              {showThoughts ? <div className="activity-feed__earlier">{thoughts.map((entry, index) => <p key={index}>{entry.text}</p>)}</div> : null}
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}
