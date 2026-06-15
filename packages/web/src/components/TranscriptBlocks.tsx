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
import { BoundedRaw } from "./BoundedRaw.tsx";

export function UserBubble({ line }: { line: UserLine }) {
  const content = line.message.content;
  if (typeof content === "string") {
    return (
      <UserCard>
        <Markdown text={content} />
      </UserCard>
    );
  }
  return (
    <UserCard>
      {content.map((block, i) => (
        <UserContentBlock key={i} block={block} />
      ))}
    </UserCard>
  );
}

// The user turn is the one thing in the transcript that sits "on top" of the
// page: a contained, elevated card. The agent renders bare on the background
// (see AssistantBubble), so the visual contract is user-on-paper.
function UserCard({ children }: { children: React.ReactNode }) {
  // Outer spacer gives the user turn a little breathing room above and below
  // (padding, not margin, so it doesn't fight the transcript's space-y gap).
  return (
    <div className="py-2">
      <div className="bg-elevated border border-border-strong rounded-lg px-3.5 py-2.5 space-y-2">
        {children}
      </div>
    </div>
  );
}

// A user-turn that clobber synthesized (wake-kick / trigger / ask-answer /
// spawn-prompt / live-inject / interrupt-notice / tool-token). Rendered with a distinct
// amber-tinted column + provenance badge so a scroll-back makes "what I typed"
// versus "what clobber injected" obvious at a glance. Composer turns stay
// untagged and render through the plain `UserBubble` above.
export function ClobberTurnBubble({ tag }: { tag: ClobberTurnTag }) {
  const via = tag.attrs["via"];
  const from = tag.attrs["from"];
  // The amber column already signals "clobber-injected", so the word is dropped
  // from the headline. `from` (set on message / message-reply turns) is the
  // caller — surface it so a relayed note shows who sent it.
  const label = [tag.type, via, from === undefined ? undefined : `from ${from}`]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <div
      data-clobber-turn-type={tag.type}
      className="border-l-2 border-provenance-muted pl-3 space-y-2"
    >
      <div className="text-xs uppercase tracking-wider text-provenance">{label}</div>
      <div className="bg-provenance-deep/30 border border-provenance-muted/40 rounded px-3 py-2">
        <Markdown text={tag.inner} />
      </div>
    </div>
  );
}

function UserContentBlock({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return <Markdown text={block.text} />;
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
  showDetails,
  toolResults,
}: {
  line: AssistantLine;
  showDetails: boolean;
  toolResults: Map<string, boolean>;
}) {
  // No rail, no wash, no speaker label: the agent's words sit directly on the
  // page background — the user turn is the only thing that gets a card.
  return (
    <div className="space-y-2">
      {line.message.content.map((block, i) => (
        <AssistantContentBlock
          key={i}
          block={block}
          showDetails={showDetails}
          toolResults={toolResults}
        />
      ))}
    </div>
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
    // Normal agent prose gets top/bottom breathing room so messages separate
    // from each other and from their tool calls — padding (not margin) so it
    // doesn't fight the surrounding space-y. Tool/thinking blocks stay tight.
    return (
      <div className="py-2">
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
  // mt-3 sets the description+tool pair apart from the preceding block; the
  // left bar (border-l) marks the unit as subordinate to the agent's prose and
  // supplies the indent; the tight inner space-y-1 keeps the description bound
  // to its tool, so each unit reads as "this description is *about* this call".
  return (
    <div className="mt-3 border-l-2 border-border-strong pl-3 space-y-1">
      {description !== null && (
        <p className="text-sm italic text-tool leading-relaxed">{description}</p>
      )}
      <div className="flex items-start gap-2 text-xs">
        <ToolStatusMark status={status} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="text-text-dim font-mono shrink-0">{name}</span>
            {preview !== null && (
              <span className="text-tool truncate font-mono">{preview}</span>
            )}
          </div>
          {showDetails && (
            <BoundedRaw
              text={JSON.stringify(input, null, 2)}
              className="whitespace-pre-wrap text-text-soft bg-bg p-2 rounded border border-border overflow-x-auto"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Tool status speaks its OWN language, deliberately not the agent-state palette
// (emerald/amber), so a colored dot in the transcript always means *agent*
// state. ok → a muted check, running → a hollow ring, and red is reserved for
// the one thing worth alarm: error.
function ToolStatusMark({ status }: { status: ToolStatus }) {
  const base = "mt-1 shrink-0 inline-flex items-center justify-center";
  if (status === "error") {
    return (
      <span
        data-status={status}
        aria-label={status}
        className={`${base} w-1.5 h-1.5 rounded-full bg-danger`}
      />
    );
  }
  if (status === "ok") {
    return (
      <span data-status={status} aria-label={status} className={`${base} text-tool text-[10px] leading-none`}>
        ✓
      </span>
    );
  }
  return (
    <span
      data-status={status}
      aria-label={status}
      className={`${base} size-1.5 rounded-full border border-text-faint`}
    />
  );
}

function RawBlock({ block }: { block: ContentBlock }) {
  return (
    <pre className="whitespace-pre-wrap text-xs text-text-subtle bg-bg p-2 rounded border border-border overflow-x-auto">
      {JSON.stringify(block, null, 2)}
    </pre>
  );
}

