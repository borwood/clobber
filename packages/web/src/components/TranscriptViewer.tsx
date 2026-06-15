import { useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TranscriptLine } from "../api.ts";
import { classifyLine, buildToolResultIndex, type Classified } from "../transcript-types.ts";
import { deriveWorkingState } from "../working-state.ts";
import { WorkingIndicator } from "./WorkingIndicator.tsx";
import {
  UserBubble,
  ClobberTurnBubble,
  AssistantBubble,
} from "./TranscriptBlocks.tsx";
import {
  NotificationCard,
  SystemLine,
  SystemPromptLine,
} from "./TranscriptCards.tsx";

interface Props {
  readonly lines: readonly TranscriptLine[];
  readonly showSystem: boolean;
  readonly busy: boolean;
}

// Feed item: every Classified kind except the two that never produce DOM output.
type FeedItem = Extract<
  Classified,
  { kind: "user" | "clobber-turn" | "assistant" | "notification" | "system" }
>;

const PIN_THRESHOLD_PX = 100;

export function TranscriptViewer({ lines, showSystem, busy }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const classified = useMemo(() => lines.map(classifyLine), [lines]);

  // Pre-filtered, pre-classified feed array. The virtualizer count = feed.length;
  // the row renderer is total — every index maps to a real DOM row, no null returns.
  const feed = useMemo(
    () =>
      classified.filter(
        (c): c is FeedItem =>
          c.kind !== "filtered" &&
          c.kind !== "thinking-pulse" &&
          (showSystem || c.kind !== "system"),
      ),
    [classified, showSystem],
  );

  const toolResults = useMemo(() => buildToolResultIndex(lines), [lines]);
  const workingState = useMemo(() => deriveWorkingState(lines), [lines]);

  const virtualizer = useVirtualizer({
    count: feed.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 5,
  });

  // Re-assert pin-to-bottom whenever the feed grows or pin state is true.
  // scrollToIndex uses estimated total height correctly; raw scrollTop = scrollHeight
  // drifts under windowing because getTotalSize() != scrollHeight at partial render.
  useLayoutEffect(() => {
    if (!pinned || feed.length === 0) return;
    virtualizer.scrollToIndex(feed.length - 1, { align: "end" });
  }, [feed.length, pinned]);

  function onScroll(_e: UIEvent<HTMLDivElement>) {
    const el = scrollRef.current;
    if (el === null) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distFromBottom < PIN_THRESHOLD_PX);
  }

  function jumpToLatest() {
    if (feed.length > 0) {
      virtualizer.scrollToIndex(feed.length - 1, { align: "end" });
    }
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
          {feed.length === 0 ? (
            <p className="text-sm text-text-subtle">
              No transcript yet. Wait for the agent to start.
            </p>
          ) : (
            <div
              className="mx-auto max-w-3xl relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full pb-3"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <FeedRow
                    item={feed[virtualItem.index]!}
                    showSystem={showSystem}
                    toolResults={toolResults}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        {!pinned && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 right-4 px-3 py-1.5 text-xs rounded-full bg-elevated text-text border border-border-strong shadow-lg hover:bg-raised"
          >
            ↓ jump to latest
          </button>
        )}
      </div>
      {busy && <WorkingIndicator state={workingState} />}
    </div>
  );
}

function FeedRow({
  item,
  showSystem,
  toolResults,
}: {
  item: FeedItem;
  showSystem: boolean;
  toolResults: Map<string, boolean>;
}) {
  if (item.kind === "user") {
    return <UserBubble line={item.line} />;
  }
  if (item.kind === "clobber-turn") {
    return <ClobberTurnBubble tag={item.tag} />;
  }
  if (item.kind === "assistant") {
    return (
      <AssistantBubble
        line={item.line}
        showDetails={showSystem}
        toolResults={toolResults}
      />
    );
  }
  if (item.kind === "notification") {
    return (
      <NotificationCard
        summary={item.summary}
        {...(item.status === undefined ? {} : { status: item.status })}
        raw={item.raw}
        showRaw={showSystem}
      />
    );
  }
  // kind === "system" — only present in feed when showSystem=true
  if (item.type === "system-prompt") {
    return <SystemPromptLine raw={item.raw} />;
  }
  return (
    <SystemLine
      type={item.type}
      {...(item.summary === undefined ? {} : { summary: item.summary })}
      raw={item.raw}
    />
  );
}
