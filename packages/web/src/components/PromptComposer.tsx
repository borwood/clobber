import { useRef, useState } from "react";
import { computeContextLength } from "../context-length.ts";
import type { TranscriptLine } from "../api.ts";
import { FilesystemBrowser } from "./FilesystemBrowser.tsx";
import { ComposerOptionsMenu } from "./ComposerOptionsMenu.tsx";
import { ComposerToolbar } from "./ComposerToolbar.tsx";
import { MarkdownEditor, type ComposerAction, type MarkdownEditorHandle } from "./MarkdownEditor.tsx";
import { ActionButton } from "./ActionButton.tsx";
import { api } from "../api.ts";
import { getDraft, setDraft } from "../draft-store.ts";

// Ceiling the editor grows to before it starts scrolling (~8 lines).
const MAX_EDITOR_HEIGHT = 192;

interface Props {
  readonly sessionId: string;
  readonly ended: boolean;
  readonly busy: boolean;
  readonly transcript?: readonly TranscriptLine[];
  readonly showDetails: boolean;
  readonly onToggleShowDetails: () => void;
  readonly onSend: (prompt: string) => Promise<void>;
  readonly onResume: (prompt?: string) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onEndSession: () => Promise<void>;
}

type FileBrowserState = { readonly path: string; readonly label: string; readonly triggerRect: DOMRect } | null;

export function PromptComposer({
  sessionId,
  ended,
  busy,
  transcript,
  showDetails,
  onToggleShowDetails,
  onSend,
  onResume,
  onInterrupt,
  onEndSession,
}: Props) {
  const [prompt, setPromptState] = useState(() => getDraft(sessionId));
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileBrowser, setFileBrowser] = useState<FileBrowserState>(null);
  const [focused, setFocused] = useState(false);
  const [richMarkdown, setRichMarkdown] = useState(true);
  const deskButtonRef = useRef<HTMLButtonElement>(null);
  const officeButtonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);

  // Mirror every edit into the per-session draft store so an unsent draft
  // survives this composer unmounting on a tab/session switch.
  function setPrompt(next: string) {
    setPromptState(next);
    setDraft(sessionId, next);
  }

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

  function onEditorAction(action: ComposerAction) {
    if (action === "interrupt") {
      void interrupt();
      return;
    }
    if (ended) {
      void resume();
    } else {
      void send();
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

  function renderActionButton() {
    if (ended) {
      return (
        <ActionButton
          variant="accent"
          onClick={() => void resume()}
          disabled={sending}
          className="px-3 py-1.5 text-xs"
        >
          {sending ? "Resuming…" : hasText ? "Resume + Send" : "Resume"}
        </ActionButton>
      );
    }
    return (
      <ActionButton
        variant="accent"
        onClick={() => void send()}
        disabled={!canSend}
        className="px-3 py-1.5 text-xs"
      >
        {sending ? "Sending…" : "Send"}
      </ActionButton>
    );
  }

  return (
    <div className="border-t border-border bg-bg p-3">
      <div className="mx-auto max-w-3xl space-y-2">
        <div
          className={`rounded border border-border bg-surface focus-within:border-border-strong ring-1 transition-[box-shadow] duration-300 ${!busy && !ended ? "ring-accent" : "ring-accent/0"}`}
        >
          <div className="flex items-center border-b border-border px-1.5 py-1">
            <ComposerToolbar
              onFormat={(format) => editorRef.current?.applyFormat(format)}
              disabled={sending}
            />
          </div>
          <MarkdownEditor
            ref={editorRef}
            value={prompt}
            onChange={setPrompt}
            onAction={onEditorAction}
            disabled={sending}
            richMarkdown={richMarkdown}
            minHeight={focused || hasText ? "4.25rem" : "1.75rem"}
            maxHeight={MAX_EDITOR_HEIGHT}
            onFocusChange={setFocused}
            placeholder={
              ended
                ? "Optional prompt to send on resume…"
                : busy
                  ? "Agent is working… (Ctrl+C to interrupt)"
                  : "Follow-up prompt… (Ctrl+Enter to send, Enter for newline)"
            }
          />
        </div>
        <div className="flex items-center gap-2 relative">
          <ComposerOptionsMenu
            richMarkdown={richMarkdown}
            onToggleRichMarkdown={() => setRichMarkdown((v) => !v)}
            showDetails={showDetails}
            onToggleShowDetails={onToggleShowDetails}
            canEndSession={!ended}
            onEndSession={() => void onEndSession()}
          />
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
            <ActionButton
              variant="danger"
              onClick={() => void interrupt()}
              disabled={interrupting}
              title="Interrupt the running turn (Ctrl+C)"
              className="ml-auto px-3 py-1.5 text-xs"
            >
              {interrupting ? "Stopping…" : "Stop"}
            </ActionButton>
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
    </div>
  );
}
