import { useRef, useState, type KeyboardEvent } from "react";
import { classifyComposerKey } from "./composer-key.ts";
import { computeContextLength } from "../context-length.ts";
import type { TranscriptLine } from "../api.ts";
import { FilesystemBrowser } from "./FilesystemBrowser.tsx";
import { api } from "../api.ts";

interface Props {
  readonly sessionId: string;
  readonly ended: boolean;
  readonly busy: boolean;
  readonly transcript?: readonly TranscriptLine[];
  readonly onSend: (prompt: string) => Promise<void>;
  readonly onResume: (prompt?: string) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
}

type FileBrowserState = { readonly path: string; readonly label: string; readonly triggerRect: DOMRect } | null;

export function PromptComposer({
  sessionId,
  ended,
  busy,
  transcript,
  onSend,
  onResume,
  onInterrupt,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileBrowser, setFileBrowser] = useState<FileBrowserState>(null);
  const deskButtonRef = useRef<HTMLButtonElement>(null);
  const officeButtonRef = useRef<HTMLButtonElement>(null);

  const hasText = prompt.trim().length > 0;
  const canSend = !ended && !sending && hasText;
  const canInterrupt = !ended && busy && !interrupting;
  const contextTokens = transcript !== undefined ? computeContextLength(transcript) : undefined;

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

  async function resume() {
    setSending(true);
    setError(null);
    try {
      await onResume(hasText ? prompt : undefined);
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

  async function openFileBrowser(target: "desk" | "office") {
    const ref = target === "desk" ? deskButtonRef : officeButtonRef;
    const triggerRect = ref.current?.getBoundingClientRect();
    setError(null);
    try {
      const locations = await api.getSessionLocations(sessionId);
      const path = target === "desk" ? locations.desk_path : locations.office_path;
      if (path === null) {
        setError("No office for this agent");
        return;
      }
      if (triggerRect === undefined) return;
      setFileBrowser({ path, label: target === "desk" ? "Desk" : "Office", triggerRect });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    const action = classifyComposerKey(e, {
      hasTextSelection: hasTextSelection(),
    });
    if (action === "send") {
      e.preventDefault();
      if (ended) {
        void resume();
      } else {
        void send();
      }
      return;
    }
    if (action === "newline") {
      return;
    }
    if (action === "interrupt") {
      if (!canInterrupt) return;
      e.preventDefault();
      void interrupt();
    }
  }

  function renderActionButton() {
    if (ended) {
      return (
        <button
          type="button"
          onClick={() => void resume()}
          disabled={sending}
          className="px-3 py-1.5 text-xs rounded bg-accent-strong text-white hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? "Resuming…" : hasText ? "Resume + Send" : "Resume"}
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => void send()}
        disabled={!canSend}
        className="px-3 py-1.5 text-xs rounded bg-accent-strong text-white hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {sending ? "Sending…" : "Send"}
      </button>
    );
  }

  return (
    <div className="border-t border-border bg-bg p-3 space-y-2">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKey}
        disabled={sending}
        placeholder={
          ended
            ? "Optional prompt to send on resume…"
            : busy
              ? "Agent is working… (Ctrl+C to interrupt)"
              : "Follow-up prompt… (Enter to send, Shift+Enter for newline)"
        }
        rows={3}
        className="w-full resize-none rounded border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong disabled:opacity-50"
      />
      <div className="flex items-center gap-2 relative">
        <span className="text-xs text-text-faint font-mono truncate">
          {sessionId.slice(0, 8)}
        </span>
        {contextTokens !== undefined && (
          <span className="text-xs text-text-faint font-mono">
            ~{Math.round(contextTokens / 1000)}k ctx
          </span>
        )}
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
          ref={deskButtonRef}
          type="button"
          onClick={() => void openFileBrowser("desk")}
          title="Browse agent desk"
          className={
            "px-2 py-1.5 text-xs rounded border border-border text-text-soft hover:text-text hover:border-border-strong " +
            (canInterrupt ? "" : "ml-auto")
          }
        >
          Desk
        </button>
        <button
          ref={officeButtonRef}
          type="button"
          onClick={() => void openFileBrowser("office")}
          title="Browse agent office"
          className="px-2 py-1.5 text-xs rounded border border-border text-text-soft hover:text-text hover:border-border-strong"
        >
          Office
        </button>
        {renderActionButton()}
        {fileBrowser !== null && (
          <FilesystemBrowser
            mode="file"
            initialPath={fileBrowser.path}
            triggerRect={fileBrowser.triggerRect}
            onCancel={() => setFileBrowser(null)}
          />
        )}
      </div>
    </div>
  );
}

function hasTextSelection(): boolean {
  const sel = window.getSelection();
  if (sel === null) return false;
  return sel.toString().length > 0;
}
