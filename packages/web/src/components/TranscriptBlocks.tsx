import {
  previewToolInput,
  toolStatus,
  type AssistantLine,
  type ClobberTurnTag,
  type UserLine,
  type ContentBlock,
  type ToolStatus,
} from "../transcript-types.ts";
import { Markdown } from "./Markdown.tsx";

export function UserBubble({ line }: { line: UserLine }) {
  const content = line.message.content;
  if (typeof content === "string") {
    return (
      <Bubble label="user" tone="zinc">
        <div className={USER_TEXT_BG}>
          <Markdown text={content} />
        </div>
      </Bubble>
    );
  }
  return (
    <Bubble label="user" tone="zinc">
      {content.map((block, i) => (
        <UserContentBlock key={i} block={block} />
      ))}
    </Bubble>
  );
}

// A user-turn that clobber synthesized (wake-kick / trigger / ask-answer /
// spawn-prompt / live-inject / interrupt-notice / tool-token). Rendered with a distinct
// amber-tinted column + provenance badge so a scroll-back makes "what I typed"
// versus "what clobber injected" obvious at a glance. Composer turns stay
// untagged and render through the plain `UserBubble` above.
export function ClobberTurnBubble({ tag }: { tag: ClobberTurnTag }) {
  const via = tag.attrs["via"];
  const label = via === undefined ? tag.type : `${tag.type} · ${via}`;
  return (
    <div
      data-clobber-turn-type={tag.type}
      className="border-l-2 border-provenance-muted pl-3 space-y-2"
    >
      <div className="text-xs uppercase tracking-wider text-provenance">
        clobber · {label}
      </div>
      <div className="bg-provenance-deep/30 border border-provenance-muted/40 rounded px-3 py-2">
        <Markdown text={tag.inner} />
      </div>
    </div>
  );
}

function UserContentBlock({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return (
      <div className={USER_TEXT_BG}>
        <Markdown text={block.text} />
      </div>
    );
  }
  if (block.type === "tool_result") {
    const text =
      typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2);
    return (
      <div className="text-xs">
        <div className="text-text-subtle mb-1">tool_result · {block.tool_use_id.slice(0, 12)}…</div>
        <pre className="whitespace-pre-wrap text-text-soft bg-bg p-2 rounded border border-border overflow-x-auto">
          {text}
        </pre>
      </div>
    );
  }
  return <RawBlock block={block} />;
}

export function AssistantBubble({
  line,
  showLabel,
  showDetails,
  toolResults,
}: {
  line: AssistantLine;
  showLabel: boolean;
  showDetails: boolean;
  toolResults: Map<string, boolean>;
}) {
  return (
    <Bubble label={showLabel ? "assistant" : null} tone="emerald">
      {line.message.content.map((block, i) => (
        <AssistantContentBlock
          key={i}
          block={block}
          showDetails={showDetails}
          toolResults={toolResults}
        />
      ))}
    </Bubble>
  );
}

function AssistantContentBlock({
  block,
  showDetails,
  toolResults,
}: {
  block: ContentBlock;
  showDetails: boolean;
  toolResults: Map<string, boolean>;
}) {
  if (block.type === "text") {
    return (
      <div className={ASSISTANT_TEXT_BG}>
        <Markdown text={block.text} />
      </div>
    );
  }
  if (block.type === "thinking") {
    if (block.thinking.trim().length === 0) return null;
    return (
      <details className="text-xs text-text-subtle">
        <summary className="cursor-pointer hover:text-text-soft">thinking</summary>
        <pre className="whitespace-pre-wrap mt-1 text-text-muted">{block.thinking}</pre>
      </details>
    );
  }
  if (block.type === "tool_use") {
    return (
      <ToolCallCard
        name={block.name}
        input={block.input}
        status={toolStatus(toolResults, block.id)}
        showDetails={showDetails}
      />
    );
  }
  return <RawBlock block={block} />;
}

// Generic tool-call summary card (#40). By construction it needs no per-tool
// rendering code: the badge is the tool name, the one-line summary comes from
// previewToolInput's generic field-priority scan, and the status dot is
// correlated by tool_use_id. A new tool renders correctly with zero changes.
// With show-details on, the full input payload is revealed verbatim (no
// markdown), mirroring the task-notification card's raw-behind-toggle pattern.
function ToolCallCard({
  name,
  input,
  status,
  showDetails,
}: {
  name: string;
  input: unknown;
  status: ToolStatus;
  showDetails: boolean;
}) {
  const obj = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const description = typeof obj["description"] === "string" && (obj["description"] as string).length > 0
    ? (obj["description"] as string)
    : null;
  const preview = previewToolInput(input);
  const dot =
    status === "error"
      ? "bg-danger"
      : status === "ok"
        ? "bg-working"
        : "bg-blocked";
  return (
    <>
      {description !== null && (
        <div className={ASSISTANT_TEXT_BG}>
          <Markdown text={description} />
        </div>
      )}
      <div className="flex items-start gap-2 text-xs">
        <span
          data-status={status}
          aria-label={status}
          className={`mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="text-accent-text font-mono shrink-0">{name}</span>
            {preview !== null && (
              <span className="text-text-muted truncate font-mono">{preview}</span>
            )}
          </div>
          {showDetails && (
            <pre className="whitespace-pre-wrap text-text-soft bg-bg p-2 rounded border border-border overflow-x-auto">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </>
  );
}

function RawBlock({ block }: { block: ContentBlock }) {
  return (
    <pre className="whitespace-pre-wrap text-xs text-text-subtle bg-bg p-2 rounded border border-border overflow-x-auto">
      {JSON.stringify(block, null, 2)}
    </pre>
  );
}

interface BubbleProps {
  readonly label: string | null;
  readonly tone: "zinc" | "emerald";
  readonly children: React.ReactNode;
}

function Bubble({ label, tone, children }: BubbleProps) {
  // Border accent stays on the column (signals speaker). Bg colors are
  // applied per text block (see ASSISTANT_TEXT_BG / USER_TEXT_BG below)
  // so that tool_use boxes — which have their own dark bg — don't sit
  // inside a coloured wash.
  const accent = tone === "emerald" ? "border-accent-muted" : "border-border";
  return (
    <div className={`border-l-2 ${accent} pl-3 space-y-2`}>
      {label !== null && (
        <div className="text-xs uppercase tracking-wider text-text-subtle">{label}</div>
      )}
      {children}
    </div>
  );
}

const ASSISTANT_TEXT_BG = "bg-accent-deep/30 border border-accent-muted/40 rounded px-3 py-2";
const USER_TEXT_BG = "bg-surface/40 border border-border/60 rounded px-3 py-2";
