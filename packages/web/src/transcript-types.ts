import type { TranscriptLine } from "./api.ts";

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: unknown;
    };

export interface UserLine {
  readonly type: "user";
  readonly message: {
    readonly role: "user";
    readonly content: string | readonly ContentBlock[];
  };
}

export interface AssistantLine {
  readonly type: "assistant";
  readonly message: {
    readonly role: "assistant";
    readonly content: readonly ContentBlock[];
  };
}

export type Classified =
  | { readonly kind: "user"; readonly line: UserLine }
  | { readonly kind: "assistant"; readonly line: AssistantLine }
  | {
      readonly kind: "thinking-pulse";
      readonly timestamp: number | null;
      readonly raw: TranscriptLine;
    }
  | {
      readonly kind: "system";
      readonly type: string;
      readonly summary?: string;
      readonly raw: TranscriptLine;
    }
  | {
      readonly kind: "notification";
      readonly summary: string;
      readonly status?: string;
      readonly raw: TranscriptLine;
    }
  | { readonly kind: "filtered"; readonly raw: TranscriptLine };

// Returns a one-line preview of a tool call's input, suitable for a
// collapsed tool-call card. Tries common identifying fields in priority
// order, falls back to the first non-empty string value, then null.
//
// Per-tool cards with status indicators / result hints are out of scope
// here — see #40 for the richer summary surface that lands on top.
const PREVIEW_PRIORITY_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "prompt",
  "description",
] as const;

export function previewToolInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, unknown>;
  for (const key of PREVIEW_PRIORITY_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return truncatePreview(value);
    }
  }
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.length > 0) {
      return truncatePreview(value);
    }
  }
  return null;
}

function truncatePreview(value: string): string {
  const firstLine = value.split("\n", 1)[0] ?? "";
  return firstLine.length > 120 ? firstLine.slice(0, 120) : firstLine;
}

// Returns true when the assistant label should render at `idx`. Within a run
// of consecutive *visible* assistant lines, the label renders only on the
// first. The run is reset by any visible non-assistant line (user, notification,
// or — when showSystem is on — a system line like tool_result/attachment).
// Invisible lines are transparent: filtered (claude's interrupt marker) is
// always invisible; system lines are invisible when showSystem is off.
// Thinking-pulse lines are also transparent — the chip is a prelude to the
// assistant's response, not a separate turn from the user's mental model.
export function shouldShowAssistantLabel(
  classified: readonly Classified[],
  idx: number,
  opts: { readonly showSystem: boolean },
): boolean {
  if (classified[idx]?.kind !== "assistant") return true;
  for (let i = idx - 1; i >= 0; i--) {
    const prev = classified[i];
    if (prev === undefined) return true;
    if (prev.kind === "filtered") continue;
    if (prev.kind === "thinking-pulse") continue;
    if (prev.kind === "system" && !opts.showSystem) continue;
    return prev.kind !== "assistant";
  }
  return true;
}

// A thinking-pulse line is "live" only when nothing else has been written
// since it. Once any other content (assistant text, tool_use, tool_result,
// user, notification, system) lands afterwards, the pulse is over and the
// chip should disappear — matching the native claude CLI's transient
// thinking widget. Other thinking-pulse and filtered lines are transparent
// and don't dismiss the chip.
export function shouldHideThinkingPulse(
  classified: readonly Classified[],
  idx: number,
): boolean {
  if (classified[idx]?.kind !== "thinking-pulse") return false;
  for (let i = idx + 1; i < classified.length; i++) {
    const next = classified[i];
    if (next === undefined) return false;
    if (next.kind === "filtered" || next.kind === "thinking-pulse") continue;
    return true;
  }
  return false;
}

export function classifyLine(line: TranscriptLine): Classified {
  const type = line["type"];
  const typeLabel = typeof type === "string" ? type : "unknown";

  if (type === "user") {
    const message = line["message"];
    if (isUserMessage(message)) {
      const content = message.content;
      if (Array.isArray(content) && content.length > 0 && content.every((b) => b.type === "tool_result")) {
        const count = content.length;
        return {
          kind: "system",
          type: "tool_result",
          summary: `${count} result${count === 1 ? "" : "s"}`,
          raw: line,
        };
      }
      if (isInterruptMarker(content)) {
        return { kind: "filtered", raw: line };
      }
      const notification = detectTaskNotification(content);
      if (notification !== null) {
        return { kind: "notification", ...notification, raw: line };
      }
      const injection = detectInjectedContext(content);
      if (injection !== null) {
        return {
          kind: "system",
          type: "injected-context",
          summary: injection,
          raw: line,
        };
      }
      return { kind: "user", line: { type: "user", message } };
    }
  }

  if (type === "assistant") {
    const message = line["message"];
    if (isAssistantMessage(message)) {
      // Claude writes thinking-only assistant lines as separate JSONL records
      // when it's still mid-turn. Render those as a transient pulse chip; the
      // real response will land in a later assistant line.
      if (
        message.content.length > 0 &&
        message.content.every(
          (b) => b.type === "thinking" && b.thinking.trim().length === 0,
        )
      ) {
        return {
          kind: "thinking-pulse",
          timestamp: parseTimestamp(line["timestamp"]),
          raw: line,
        };
      }
      return { kind: "assistant", line: { type: "assistant", message } };
    }
  }

  const summary = summarizeSystem(typeLabel, line);
  if (summary === undefined) {
    return { kind: "system", type: typeLabel, raw: line };
  }
  return { kind: "system", type: typeLabel, summary, raw: line };
}

function summarizeSystem(type: string, line: TranscriptLine): string | undefined {
  if (type === "permission-mode") {
    const mode = line["permissionMode"];
    if (typeof mode === "string") return `→ ${mode}`;
    return undefined;
  }
  if (type === "queue-operation") {
    const op = line["operation"];
    if (typeof op === "string") return op;
    return undefined;
  }
  if (type === "attachment") {
    const list = line["attachments"];
    if (Array.isArray(list)) return `${list.length} file${list.length === 1 ? "" : "s"}`;
    return undefined;
  }
  if (type === "file-history-snapshot") {
    const files = line["files"];
    if (Array.isArray(files)) return `${files.length} file${files.length === 1 ? "" : "s"}`;
    return undefined;
  }
  return undefined;
}

// Synthetic user-turn marker that claude inserts into its transcript when a
// turn is aborted via the stream-json `control_request` interrupt. Matches
// the native `claude` CLI's filter behavior — keeps the transcript readable
// without a phantom user message every time the user hits interrupt.
const INTERRUPT_MARKER = "[Request interrupted by user]";

function isInterruptMarker(content: string | readonly ContentBlock[]): boolean {
  const text = extractLeadingText(content);
  if (text === null) return false;
  return text.trim() === INTERRUPT_MARKER;
}

// Two formats appear in transcripts:
// 1. Our server-injected marker (interrupt, etc.) — leading text starts with
//    `[SYSTEM NOTIFICATION` followed by a `<task-notification>` block.
// 2. Claude's native background-task notifications — leading text starts
//    directly with `<task-notification>` (no header).
const NOTIFICATION_PREFIX = "[SYSTEM NOTIFICATION";
const TASK_NOTIFICATION_TAG = "<task-notification>";

function detectTaskNotification(
  content: string | readonly ContentBlock[],
): { summary: string; status?: string } | null {
  const text = extractLeadingText(content);
  if (text === null) return null;
  const trimmed = text.trimStart();
  const matches =
    trimmed.startsWith(NOTIFICATION_PREFIX) ||
    trimmed.startsWith(TASK_NOTIFICATION_TAG);
  if (!matches) return null;
  const summaryMatch = trimmed.match(/<summary>([\s\S]*?)<\/summary>/);
  const statusMatch = trimmed.match(/<status>([\s\S]*?)<\/status>/);
  const status = statusMatch === null ? undefined : statusMatch[1]?.trim();
  const rawSummary = summaryMatch === null ? undefined : summaryMatch[1]?.trim();
  const summary =
    rawSummary !== undefined && rawSummary.length > 0
      ? rawSummary
      : status !== undefined
        ? `background task ${status}`
        : "background task event";
  return status === undefined ? { summary } : { summary, status };
}

const INJECTION_TAGS = [
  "system-reminder",
  "local-command-stdout",
  "local-command-stderr",
  "user-prompt-submit-hook",
] as const;

const SKILL_BODY_PREFIX = "Base directory for this skill:";

function detectInjectedContext(
  content: string | readonly ContentBlock[],
): string | null {
  const text = extractLeadingText(content);
  if (text === null) return null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith(SKILL_BODY_PREFIX)) {
    const rest = trimmed.slice(SKILL_BODY_PREFIX.length).trimStart();
    const path = rest.split(/\s/, 1)[0] ?? "";
    const name = path.split("/").filter((s) => s.length > 0).pop();
    return name !== undefined && name.length > 0 ? `skill · ${name}` : "skill";
  }
  for (const tag of INJECTION_TAGS) {
    if (trimmed.startsWith(`<${tag}>`)) return tag;
  }
  return null;
}

function extractLeadingText(
  content: string | readonly ContentBlock[],
): string | null {
  if (typeof content === "string") return content;
  for (const block of content) {
    if (block.type === "text") return block.text;
    if (block.type === "tool_result") return null;
  }
  return null;
}

function isUserMessage(value: unknown): value is UserLine["message"] {
  if (value === null || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  if (msg["role"] !== "user") return false;
  const content = msg["content"];
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every(isContentBlock);
}

function isAssistantMessage(value: unknown): value is AssistantLine["message"] {
  if (value === null || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  if (msg["role"] !== "assistant") return false;
  const content = msg["content"];
  return Array.isArray(content) && content.every(isContentBlock);
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (value === null || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>)["type"] === "string";
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
