import type { TranscriptLine } from "../api.ts";

export function NotificationCard({
  summary,
  status,
  raw,
  showRaw,
}: {
  summary: string;
  status?: string;
  raw: TranscriptLine;
  showRaw: boolean;
}) {
  const tone =
    status === "failed"
      ? "border-danger-muted bg-danger-muted/40 text-danger-text"
      : status === "completed"
        ? "border-accent-muted bg-accent-deep/30 text-accent-text"
        : "border-border bg-surface/60 text-text-dim";
  const dot =
    status === "failed"
      ? "bg-danger"
      : status === "completed"
        ? "bg-working"
        : "bg-done";
  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 rounded border text-xs ${tone}`}
    >
      <span className={`mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="uppercase tracking-wider text-[10px] opacity-70">
            background task{status === undefined ? "" : ` · ${status}`}
          </span>
        </div>
        <div className="break-words">{summary}</div>
        {showRaw && (
          <pre className="mt-1 whitespace-pre-wrap text-[10px] text-text-subtle bg-bg p-2 rounded border border-border overflow-x-auto">
            {JSON.stringify(raw, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

export function SystemLine({
  type,
  summary,
  raw,
}: {
  type: string;
  summary?: string;
  raw: TranscriptLine;
}) {
  return (
    <details className="text-xs text-text-subtle leading-snug">
      <summary className="cursor-pointer hover:text-text-soft select-none">
        <span className="font-mono text-text-muted">{type}</span>
        {summary !== undefined && (
          <span className="text-text-subtle"> · {summary}</span>
        )}
      </summary>
      <pre className="whitespace-pre-wrap mt-1 text-text-subtle bg-bg p-2 rounded border border-border overflow-x-auto">
        {JSON.stringify(raw, null, 2)}
      </pre>
    </details>
  );
}

// The clobber-composed system prompt (#253). Rendered as a collapsed entry
// that expands to the full prompt text — readable prose, not escaped JSON like
// the generic SystemLine. Gated behind showSystem by the caller.
export function SystemPromptLine({ raw }: { raw: TranscriptLine }) {
  const prompt = raw["prompt"];
  const text = typeof prompt === "string" ? prompt : JSON.stringify(raw, null, 2);
  return (
    <details className="text-xs text-text-subtle leading-snug">
      <summary className="cursor-pointer hover:text-text-soft select-none">
        <span className="font-mono text-text-muted">system prompt</span>
        <span className="text-text-subtle"> · composed at spawn</span>
      </summary>
      <pre className="whitespace-pre-wrap mt-1 text-text-muted bg-bg p-2 rounded border border-border overflow-x-auto">
        {text}
      </pre>
    </details>
  );
}
