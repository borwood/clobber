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
  | { readonly kind: "skip" }
  | { readonly kind: "user"; readonly line: UserLine }
  | { readonly kind: "assistant"; readonly line: AssistantLine }
  | { readonly kind: "unknown" };

const SKIP_TYPES = new Set(["permission-mode", "file-history-snapshot"]);

export function classifyLine(line: TranscriptLine): Classified {
  const type = line["type"];
  if (typeof type !== "string") return { kind: "unknown" };
  if (SKIP_TYPES.has(type)) return { kind: "skip" };

  if (type === "user") {
    const message = line["message"];
    if (!isUserMessage(message)) return { kind: "unknown" };
    return { kind: "user", line: { type: "user", message } };
  }

  if (type === "assistant") {
    const message = line["message"];
    if (!isAssistantMessage(message)) return { kind: "unknown" };
    return { kind: "assistant", line: { type: "assistant", message } };
  }

  return { kind: "unknown" };
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
