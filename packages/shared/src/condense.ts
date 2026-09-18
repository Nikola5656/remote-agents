export interface CondenseInput {
  fullText: string;
  actions: string[];
  status: "running" | "finished" | "error" | "cancelled" | "idle" | "queued";
  toolCount?: number;
  /** Milliseconds since the current run started (running status only). */
  elapsedMs?: number;
}

export interface CondensedView {
  percent: number;
  headline: string;
  summary: string;
  lastActions: string[];
  condensedLog: string;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Honest progress estimate.
 *
 * There is no ground-truth "% done" for an agent run, so this reports
 * lifecycle-based progress that starts low and only grows with observed
 * activity (tool calls + elapsed time). It never jumps to a high number
 * at the start of a run and never uses keyword guessing.
 */
export function estimatePercent(input: CondenseInput): number {
  if (input.status === "finished") return 100;
  if (input.status === "idle" || input.status === "queued") return 0;

  const tools = input.toolCount ?? input.actions.length;
  const minutes = Math.max(0, (input.elapsedMs ?? 0) / 60_000);
  // Starts at ~3%, grows with activity, caps below 100 until finish.
  const pct = 3 + tools * 4 + Math.min(35, Math.sqrt(minutes) * 14);

  if (input.status === "error" || input.status === "cancelled") {
    return Math.round(Math.min(90, pct));
  }
  return Math.round(Math.min(92, pct));
}

export function condenseOutput(input: CondenseInput): CondensedView {
  const lines = input.fullText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const useful = sentences(input.fullText).filter(
    (s) => s.length > 0 && !/^```/.test(s)
  );
  const headline =
    useful.length > 0
      ? clip(useful[useful.length - 1], 90)
      : input.status === "running"
        ? "Working…"
        : input.status === "queued"
          ? "Queued"
          : "Idle";

  const bullets = (useful.slice(-3).length ? useful.slice(-3) : lines.slice(-3))
    .map((s) => "• " + clip(s, 110))
    .slice(-3);

  const lastActions = input.actions.slice(-4).map(action => clip(action, 240));
  const percent = estimatePercent(input);
  const summary = clip(
    useful.slice(-2).join(" ") || lines.slice(-2).join(" "),
    180
  );

  const condensedLog = [
    `${input.status === "finished" ? "Completed" : input.status.charAt(0).toUpperCase() + input.status.slice(1)} · ${headline}`,
    lastActions.length ? "Actions: " + lastActions.join(" → ") : "",
    ...bullets,
  ]
    .filter(Boolean)
    .join("\n");

  return { percent, headline, summary, lastActions, condensedLog };
}
