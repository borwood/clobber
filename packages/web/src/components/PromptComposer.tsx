import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { classifyComposerKey } from "./composer-key.ts";
import { computeContextLength } from "../context-length.ts";
import type { TranscriptLine } from "../api.ts";
import { FilesystemBrowser } from "./FilesystemBrowser.tsx";
import { Markdown } from "./Markdown.tsx";
import { ComposerOptionsMenu } from "./ComposerOptionsMenu.tsx";
import { ActionButton } from "./ActionButton.tsx";
import { api } from "../api.ts";
import { getDraft, setDraft } from "../draft-store.ts";

// Ceiling the textarea grows to before it starts scrolling (~8 lines).
const MAX_TEXTAREA_HEIGHT = 192;

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
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const deskButtonRef = useRef<HTMLButtonElement>(null);
  const officeButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Grow the textarea to fit its content up to a ceiling, then scroll. The CSS
  // min-height (set on the element) supplies the floor: one line when idle+empty,
  // the taller resting size once focused or filled. Re-runs on text + focus
  // changes and after a programmatic clear (send), since those aren't input events.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [prompt, focused]);

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

  function insertHardBreak() {
    const el = textareaRef.current;
    if (el === null) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const insert = "\\\n";
    setPrompt(prompt.slice(0, start) + insert + prompt.slice(end));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + insert.length;
    });
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
      // Interim hard-break: a single "\n" is a soft break that markdown
      // collapses to a space, so what's typed wouldn't match what renders.
      // A trailing backslash is CommonMark's hard line break. Proper fix rides
      // the live-markdown-editor issue (CodeMirror 6).
      e.preventDefault();
      insertHardBreak();
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
      {markdownPreview && hasText && (
        <div className="rounded border border-border bg-surface/40 px-3 py-2 max-h-40 overflow-y-auto">
          <Markdown text={prompt} />
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={sending}
        placeholder={
          ended
            ? "Optional prompt to send on resume…"
            : busy
              ? "Agent is working… (Ctrl+C to interrupt)"
              : "Follow-up prompt… (Enter to send, Shift+Enter for newline)"
        }
        style={{
          minHeight: focused || hasText ? "4.75rem" : "2.25rem",
          maxHeight: `${MAX_TEXTAREA_HEIGHT}px`,
        }}
        className={`w-full resize-none overflow-y-auto rounded border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong disabled:opacity-50 ring-1 transition-[box-shadow] duration-300 ${!busy && !ended ? "ring-accent" : "ring-accent/0"}`}
      />
      <div className="flex items-center gap-2 relative">
        <ComposerOptionsMenu
          markdownPreview={markdownPreview}
          onToggleMarkdownPreview={() => setMarkdownPreview((v) => !v)}
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

function hasTextSelection(): boolean {
  const sel = window.getSelection();
  if (sel === null) return false;
  return sel.toString().length > 0;
}
