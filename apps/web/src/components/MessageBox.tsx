import type { DeliveryMode } from "@remote-agents/shared";
import { useEffect, useId, useState } from "react";

type Props = {
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  running?: boolean;
  /** Populates the textarea for user review; never auto-sends. */
  draft?: string | null;
  onSend: (text: string, mode: DeliveryMode) => Promise<void>;
};

export function MessageBox({
  placeholder = "Instruction for this agent…",
  disabled,
  busy,
  running = true,
  draft,
  onSend,
}: Props) {
  const fieldId = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState<DeliveryMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    if (draft && draft.trim()) {
      setText(draft);
      setError(null);
    }
  }, [draft]);

  const locked = disabled || busy || sending !== null;
  const canSend = !locked && text.trim().length > 0;

  async function submit(mode: DeliveryMode) {
    const value = text.trim();
    if (!value || locked) return;
    setSending(mode);
    setError(null);
    setReceipt(null);
    try {
      await onSend(value, mode);
      setText("");
      setReceipt(mode === "interrupt" ? "Accepted. The agent will switch to your new instruction." : running ? "Accepted and queued. It will run after the current task." : "Accepted by the worker. Follow its progress above.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="message-box">
      <label className="sr-only" htmlFor={fieldId}>
        Message
      </label>
      <textarea
        id={fieldId}
        className="message-box__input"
        value={text}
        disabled={locked}
        placeholder={placeholder}
        rows={2}
        enterKeyHint="send"
        onChange={(e) => { setText(e.target.value); setReceipt(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit("queue");
          }
        }}
      />
      <div className="message-box__actions">
        <button
          type="button"
          className="btn btn--queue"
          disabled={!canSend}
          onClick={() => void submit("queue")}
        >
          {sending === "queue" ? "Sending…" : running ? "Add to queue" : "Send instruction"}
        </button>
        {running ? <button
          type="button"
          className="btn btn--interrupt"
          disabled={!canSend || !running}
          onClick={() => void submit("interrupt")}
        >
          {sending === "interrupt" ? "Interrupting…" : "Interrupt & run"}
        </button> : null}
      </div>
      {receipt ? <p className="message-box__receipt" role="status">{receipt}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}
