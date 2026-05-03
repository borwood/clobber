import { useLayoutEffect, useRef, useState, type UIEvent } from "react";
import type { TranscriptLine } from "../api.ts";
import {
  classifyLine,
  type AssistantLine,
  type UserLine,
  type ContentBlock,
} from "../transcript-types.ts";

interface Props {
  readonly lines: readonly TranscriptLine[];
  readonly showSystem: boolean;
}

const PIN_THRESHOLD_PX = 100;

export function TranscriptViewer({ lines, showSystem }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

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
            {lines.map((line, idx) => {
              const classified = classifyLine(line);
              if (classified.kind === "user") {
                return <UserBubble key={idx} line={classified.line} />;
              }
              if (classified.kind === "assistant") {
                return <AssistantBubble key={idx} line={classified.line} />;
              }
              if (!showSystem) return null;
              return (
                <SystemLine
                  key={idx}
                  type={classified.type}
                  {...(classified.summary === undefined ? {} : { summary: classified.summary })}
                  raw={classified.raw}
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
        <pre className="whitespace-pre-wrap text-sm text-zinc-200">{content}</pre>
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
    return <pre className="whitespace-pre-wrap text-sm text-zinc-200">{block.text}</pre>;
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

function AssistantBubble({ line }: { line: AssistantLine }) {
  return (
    <Bubble label="assistant" tone="emerald">
      {line.message.content.map((block, i) => (
        <AssistantContentBlock key={i} block={block} />
      ))}
    </Bubble>
  );
}

function AssistantContentBlock({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return <pre className="whitespace-pre-wrap text-sm text-zinc-100">{block.text}</pre>;
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
    return (
      <div className="text-xs">
        <div className="text-emerald-400 mb-1 font-mono">
          {block.name} · {block.id.slice(0, 12)}…
        </div>
        <pre className="whitespace-pre-wrap text-zinc-300 bg-zinc-950 p-2 rounded border border-zinc-800 overflow-x-auto">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
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
  readonly label: string;
  readonly tone: "zinc" | "emerald";
  readonly children: React.ReactNode;
}

function Bubble({ label, tone, children }: BubbleProps) {
  const accent = tone === "emerald" ? "border-emerald-900" : "border-zinc-800";
  return (
    <div className={`border-l-2 ${accent} pl-3 space-y-2`}>
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      {children}
    </div>
  );
}
