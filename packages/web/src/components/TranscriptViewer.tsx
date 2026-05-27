import { useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import type { TranscriptLine } from "../api.ts";
import {
  classifyLine,
  shouldShowAssistantLabel,
  buildToolResultIndex,
} from "../transcript-types.ts";
import { deriveWorkingState } from "../working-state.ts";
import { WorkingIndicator } from "./WorkingIndicator.tsx";
import {
  UserBubble,
  AssistantBubble,
  NotificationCard,
  SystemLine,
  SystemPromptLine,
} from "./TranscriptBlocks.tsx";

interface Props {
  readonly lines: readonly TranscriptLine[];
  readonly showSystem: boolean;
  readonly busy: boolean;
}

const PIN_THRESHOLD_PX = 100;

export function TranscriptViewer({ lines, showSystem, busy }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const classified = useMemo(() => lines.map(classifyLine), [lines]);
  const toolResults = useMemo(() => buildToolResultIndex(lines), [lines]);
  const workingState = useMemo(() => deriveWorkingState(lines), [lines]);

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
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="relative flex-1 overflow-hidden">
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
                    showDetails={showSystem}
                    toolResults={toolResults}
                  />
                );
              }
              if (c.kind === "thinking-pulse") {
                // The live "thinking" tail is now surfaced by the turn-level
                // WorkingIndicator footer; the pulse line itself renders nothing.
                return null;
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
              if (c.type === "system-prompt") {
                return <SystemPromptLine key={idx} raw={c.raw} />;
              }
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
      {busy && <WorkingIndicator state={workingState} />}
    </div>
  );
}
