/** Scope the summary to the latest exact recorded instruction; the full log is unchanged. */
export function currentActivityTranscript(log: string, instruction: string | null, running: boolean, runStarted = false): string {
  if (!instruction) return log;
  if (running && !runStarted) return "";
  const marker = `> ${instruction.trimEnd()}`;
  let index = log.lastIndexOf(marker);
  while (index >= 0) {
    const end = index + marker.length;
    if ((index === 0 || log[index - 1] === "\n") && (end === log.length || log[end] === "\n")) {
      return log.slice(end).replace(/^\n/, "");
    }
    if (index === 0) break;
    index = log.lastIndexOf(marker, index - 1);
  }
  // A running transcript can outgrow its cap and lose the instruction marker.
  return log;
}

/** A presentation of observed transcript events, never an estimate of progress. */
export type ActivityEntry = {
  kind: "message" | "thinking" | "action" | "system";
  text: string;
  completed?: boolean;
};

export type ActivityStep = { title: string; detail: string; completed: boolean };

export function describeAction(action: string, completed = false): ActivityStep {
  const match = action.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const tool = match?.[1]?.toLowerCase() ?? "tool";
  const detail = match?.[2] ?? "";
  const executable = tool.split(/[\\/]/).pop() ?? tool;
  if (["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd.exe"].includes(executable)) {
    return { title: completed ? "Command finished" : "Command started", detail: action, completed };
  }
  const titles: Record<string, [string, string]> = {
    shell: ["Command started", "Command finished"],
    bash: ["Command started", "Command finished"],
    exec_command: ["Command started", "Command finished"],
    read: ["Read requested", "File read"],
    read_file: ["Read requested", "File read"],
    edit: ["Edit requested", "Edit finished"],
    write: ["Write requested", "Write finished"],
    apply_patch: ["Changes requested", "Changes applied"],
    grep: ["File search started", "Search finished"],
    rg: ["File search started", "Search finished"],
    glob: ["File search started", "File search finished"],
    search: ["Search started", "Search finished"],
    web_search: ["Web search started", "Web search finished"],
    subagent: ["Task delegated", "Delegated task finished"],
    "report:": ["Report available", "Report available"],
    "artifact": ["Document feedback", "Document feedback"],
  };
  return {
    title: titles[tool]?.[completed ? 1 : 0] ?? (completed ? "Tool finished" : "Tool activity"),
    detail: titles[tool] ? detail : action,
    completed,
  };
}

/** Find the closing quote of a shell -c argument, respecting shell escapes. */
function shellArgumentEnd(command: string, start: number, quote: string): number {
  for (let index = start; index < command.length; index += 1) {
    if (quote === '"' && command[index] === "\\") { index += 1; continue; }
    if (command[index] === quote) return index;
  }
  return -1;
}

/** Only consume a multiline command when its shell argument has a visible closing quote. */
function multilineShellEnd(lines: string[], index: number, action: string): number {
  const shell = action.match(/^(?:[^\s]*[\\/])?(?:sh|bash|zsh|dash|ksh|fish)\s+(?:-[a-zA-Z]*c|--command)\s+(['"])/);
  if (!shell) return index;
  const quote = shell[1];
  const argumentStart = shell[0].length;
  if (shellArgumentEnd(action, argumentStart, quote) >= 0) return index;
  let command = action;
  for (let end = index + 1; end < lines.length; end += 1) {
    // A new recorded event means the original tool label was incomplete. Keep
    // subsequent prose visible instead of swallowing it into an unterminated command.
    if (/^(?:[→✓]\s|\[thinking\]|⧉ subagent |Model:\s)/.test(lines[end])) break;
    const scanStart = command.length;
    command += `\n${lines[end]}`;
    if (shellArgumentEnd(command, scanStart, quote) >= 0) return end;
  }
  return index;
}

/** Retains prose and code verbatim; marker interpretation is disabled in fenced code. */
export function parseActivityTranscript(log: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let buffer: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  function flush() {
    const text = buffer.join("\n").trim();
    if (text) entries.push({ kind: "message", text });
    buffer = [];
  }
  const lines = log.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenced = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenced) {
      const token = fenced[1];
      if (!fence) fence = { marker: token[0], length: token.length };
      else if (token[0] === fence.marker && token.length >= fence.length) fence = null;
      buffer.push(line);
      continue;
    }
    if (fence) { buffer.push(line); continue; }
    const tool = line.match(/^(→|✓)\s+(.+)$/);
    const thought = line.match(/^\[thinking\]\s*([\s\S]*)$/);
    const delegated = line.match(/^⧉ subagent (.+) (started|finished)$/);
    const model = /^Model:\s/.test(line);
    if (tool || thought || delegated || model) {
      flush();
      if (tool) {
        const end = multilineShellEnd(lines, index, tool[2]);
        const text = [tool[2], ...lines.slice(index + 1, end + 1)].join("\n");
        entries.push({ kind: "action", text, completed: tool[1] === "✓" });
        index = end;
      }
      else if (thought) entries.push({ kind: "thinking", text: thought[1] });
      else if (delegated) entries.push({ kind: "action", text: `subagent ${delegated[1]}`, completed: delegated[2] === "finished" });
      else entries.push({ kind: "system", text: line });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return entries;
}

/** Match completion to its most recent unfinished invocation, not every same-named tool. */
export function activitySteps(entries: ActivityEntry[]): ActivityStep[] {
  const steps: Array<ActivityStep & { raw: string }> = [];
  for (const entry of entries) {
    if (entry.kind !== "action") continue;
    if (entry.completed) {
      let index = steps.length - 1;
      while (index >= 0 && (steps[index].raw !== entry.text || steps[index].completed)) index -= 1;
      if (index >= 0) {
        steps[index] = { ...describeAction(entry.text, true), raw: entry.text };
        continue;
      }
    }
    steps.push({ ...describeAction(entry.text, entry.completed), raw: entry.text });
  }
  return steps;
}

export function activityResponse(entries: ActivityEntry[], pinnedPrompt: string | null): {
  latest: string;
  earlier: ActivityEntry[];
} {
  // Only remove an exact known instruction. Blockquotes in agent responses stay intact.
  const prompt = pinnedPrompt ? `> ${pinnedPrompt.trim()}` : "";
  const messages = entries.filter((entry) => entry.kind === "message").map((entry) => ({
    ...entry,
    text: prompt && entry.text.startsWith(prompt)
      && (entry.text.length === prompt.length || entry.text[prompt.length] === "\n")
      ? entry.text.slice(prompt.length).trim() : entry.text,
  })).filter((entry) => entry.text);
  return { latest: messages[messages.length - 1]?.text ?? "", earlier: messages.slice(0, -1) };
}
