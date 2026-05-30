import { useState, type KeyboardEvent } from "react";
import { classifyComposerKey } from "./composer-key.ts";

interface Props {
  readonly sessionId: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onSend: (prompt: string) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
}

export function PromptComposer({
  sessionId,
  disabled,
  busy,
  onSend,
  onInterrupt,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = !disabled && !sending && prompt.trim().length > 0;
  const canInterrupt = !disabled && busy && !interrupting;

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(prompt);
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  async function interrupt() {
    if (!canInterrupt) return;
    setInterrupting(true);
    setError(null);
    try {
      await onInterrupt();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInterrupting(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    const action = classifyComposerKey(e, {
      hasTextSelection: hasTextSelection(),
    });
    if (action === "send") {
      e.preventDefault();
      void send();
      return;
    }
    if (action === "newline") {
      // Default textarea behavior already inserts a newline; nothing to do.
      return;
    }
    if (action === "interrupt") {
      if (!canInterrupt) return;
      e.preventDefault();
      void interrupt();
    }
  }

  return (
    <div className="border-t border-border bg-bg p-3 space-y-2">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKey}
        disabled={disabled || sending}
        placeholder={
          disabled
            ? "Session ended."
            : busy
              ? "Agent is working… (Ctrl+C to interrupt)"
              : "Follow-up prompt… (Enter to send, Shift+Enter for newline)"
        }
        rows={3}
        className="w-full resize-none rounded border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong disabled:opacity-50"
      />
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-faint font-mono truncate">
          {sessionId.slice(0, 8)}
        </span>
        {error !== null && (
          <span className="text-xs text-danger-text truncate" title={error}>
            {error}
          </span>
        )}
        {canInterrupt && (
          <button
            type="button"
            onClick={() => void interrupt()}
            disabled={interrupting}
            title="Interrupt the running turn (Ctrl+C)"
            className="ml-auto px-3 py-1.5 text-xs rounded bg-danger-strong text-white hover:bg-danger-strong disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {interrupting ? "Stopping…" : "Stop"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          className={
            "px-3 py-1.5 text-xs rounded bg-accent-strong text-white hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed " +
            (canInterrupt ? "" : "ml-auto")
          }
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function hasTextSelection(): boolean {
  const sel = window.getSelection();
  if (sel === null) return false;
  return sel.toString().length > 0;
}
