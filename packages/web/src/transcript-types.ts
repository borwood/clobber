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

const NOTIFICATION_PREFIX = "[SYSTEM NOTIFICATION";

function detectTaskNotification(
  content: string | readonly ContentBlock[],
): { summary: string; status?: string } | null {
  const text = extractLeadingText(content);
  if (text === null) return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(NOTIFICATION_PREFIX)) return null;
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
