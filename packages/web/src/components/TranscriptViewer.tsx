import { useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import type { TranscriptLine } from "../api.ts";
import {
  classifyLine,
  shouldShowAssistantLabel,
  previewToolInput,
  type AssistantLine,
  type UserLine,
  type ContentBlock,
} from "../transcript-types.ts";
import { Markdown } from "./Markdown.tsx";

interface Props {
  readonly lines: readonly TranscriptLine[];
  readonly showSystem: boolean;
}

const PIN_THRESHOLD_PX = 100;

export function TranscriptViewer({ lines, showSystem }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const classified = useMemo(() => lines.map(classifyLine), [lines]);

  useLayoutEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, pinned, showSystem]);

  function onScroll(_e: UIEvent<HTMLDivElement>) {
    const el = scrollRef.current;
    if (el === null) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distFromBottom < PIN_THRESHOLD_PX);
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinned(true);
  }

  return (
    <div className="flex-1 relative overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto px-6 pb-6"
      >
        {lines.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No transcript yet. Wait for the agent to start.
          </p>
        ) : (
          <div className="space-y-3">
            {classified.map((c, idx) => {
              if (c.kind === "filtered") {
                return null;
              }
              if (c.kind === "user") {
                return <UserBubble key={idx} line={c.line} />;
              }
              if (c.kind === "assistant") {
                return (
                  <AssistantBubble
                    key={idx}
                    line={c.line}
                    showLabel={shouldShowAssistantLabel(classified, idx, { showSystem })}
                  />
                );
              }
              if (c.kind === "notification") {
                return (
                  <NotificationCard
                    key={idx}
                    summary={c.summary}
                    {...(c.status === undefined ? {} : { status: c.status })}
                    raw={c.raw}
                    showRaw={showSystem}
                  />
                );
              }
              if (!showSystem) return null;
              return (
                <SystemLine
                  key={idx}
                  type={c.type}
                  {...(c.summary === undefined ? {} : { summary: c.summary })}
                  raw={c.raw}
                />
              );
            })}
          </div>
        )}
      </div>
      {!pinned && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-4 px-3 py-1.5 text-xs rounded-full bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-lg hover:bg-zinc-700"
        >
          ↓ jump to latest
        </button>
      )}
    </div>
  );
}

function UserBubble({ line }: { line: UserLine }) {
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
        <div className="text-zinc-500 mb-1">tool_result · {block.tool_use_id.slice(0, 12)}…</div>
        <pre className="whitespace-pre-wrap text-zinc-300 bg-zinc-950 p-2 rounded border border-zinc-800 overflow-x-auto">
          {text}
        </pre>
      </div>
    );
  }
  return <RawBlock block={block} />;
}

function AssistantBubble({
  line,
  showLabel,
}: {
  line: AssistantLine;
  showLabel: boolean;
}) {
  return (
    <Bubble label={showLabel ? "assistant" : null} tone="emerald">
      {line.message.content.map((block, i) => (
        <AssistantContentBlock key={i} block={block} />
      ))}
    </Bubble>
  );
}

function AssistantContentBlock({ block }: { block: ContentBlock }) {
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
      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer hover:text-zinc-300">thinking</summary>
        <pre className="whitespace-pre-wrap mt-1 text-zinc-400">{block.thinking}</pre>
      </details>
    );
  }
  if (block.type === "tool_use") {
    const preview = previewToolInput(block.input);
    return (
      <details className="text-xs group">
        <summary className="cursor-pointer list-none flex items-baseline gap-2 hover:bg-zinc-900/40 rounded px-1 py-0.5 -mx-1">
          <span className="text-zinc-600 group-open:rotate-90 transition-transform inline-block w-2 select-none">
            ▸
          </span>
          <span className="text-emerald-400 font-mono shrink-0">{block.name}</span>
          {preview !== null && (
            <span className="text-zinc-400 truncate font-mono">{preview}</span>
          )}
        </summary>
        <pre className="whitespace-pre-wrap text-zinc-300 bg-zinc-950 p-2 mt-1 rounded border border-zinc-800 overflow-x-auto">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </details>
    );
  }
  return <RawBlock block={block} />;
}

function RawBlock({ block }: { block: ContentBlock }) {
  return (
    <pre className="whitespace-pre-wrap text-xs text-zinc-500 bg-zinc-950 p-2 rounded border border-zinc-800 overflow-x-auto">
      {JSON.stringify(block, null, 2)}
    </pre>
  );
}

function NotificationCard({
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
      ? "border-red-900 bg-red-950/40 text-red-200"
      : status === "completed"
        ? "border-emerald-900 bg-emerald-950/30 text-emerald-200"
        : "border-zinc-800 bg-zinc-900/60 text-zinc-200";
  const dot =
    status === "failed"
      ? "bg-red-500"
      : status === "completed"
        ? "bg-emerald-500"
        : "bg-zinc-500";
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
          <pre className="mt-1 whitespace-pre-wrap text-[10px] text-zinc-500 bg-zinc-950 p-2 rounded border border-zinc-800 overflow-x-auto">
            {JSON.stringify(raw, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function SystemLine({
  type,
  summary,
  raw,
}: {
  type: string;
  summary?: string;
  raw: TranscriptLine;
}) {
  return (
    <details className="text-xs text-zinc-500 leading-snug">
      <summary className="cursor-pointer hover:text-zinc-300 select-none">
        <span className="font-mono text-zinc-400">{type}</span>
        {summary !== undefined && (
          <span className="text-zinc-500"> · {summary}</span>
        )}
      </summary>
      <pre className="whitespace-pre-wrap mt-1 text-zinc-500 bg-zinc-950 p-2 rounded border border-zinc-800 overflow-x-auto">
        {JSON.stringify(raw, null, 2)}
      </pre>
    </details>
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
  const accent = tone === "emerald" ? "border-emerald-900" : "border-zinc-800";
  return (
    <div className={`border-l-2 ${accent} pl-3 space-y-2`}>
      {label !== null && (
        <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      )}
      {children}
    </div>
  );
}

const ASSISTANT_TEXT_BG = "bg-zinc-900/40 border border-zinc-800/60 rounded px-3 py-2";
const USER_TEXT_BG = "bg-emerald-950/30 border border-emerald-900/40 rounded px-3 py-2";
