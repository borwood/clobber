import type { RuntimeEvent, RuntimeTokenUsage } from "./runtime-events.ts";

interface JsonObject {
  readonly [key: string]: unknown;
}

export function parseCodexExecJsonl(text: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (raw.length === 0) continue;
    try {
      events.push(...normalizeCodexExecEvent(JSON.parse(raw)));
    } catch {
      events.push({ kind: "unknown", eventType: "malformed-json", payload: raw });
    }
  }
  return events;
}

export function normalizeCodexExecEvent(raw: unknown): RuntimeEvent[] {
  if (!isObject(raw)) {
    return [{ kind: "unknown", eventType: "non-object", payload: raw }];
  }

  const type = stringField(raw, "type") ?? "unknown";
  if (type === "thread.started") {
    const threadId = stringField(raw, "thread_id");
    if (threadId === undefined) return unknown(type, raw);
    return [{ kind: "provider-thread-started", providerThreadId: threadId }];
  }
  if (type === "turn.started") return [{ kind: "turn-started" }];
  if (type === "turn.completed") {
    return [{ kind: "turn-completed", ...usageFrom(raw["usage"]) }];
  }
  if (type === "turn.failed" || type === "error") {
    return [{ kind: "turn-failed", message: errorMessage(raw) }];
  }
  if (type === "item.completed") {
    const item = raw["item"];
    if (!isObject(item)) return unknown(type, raw);
    return normalizeCompletedItem(item, raw);
  }
  return unknown(type, raw);
}

function normalizeCompletedItem(item: JsonObject, raw: JsonObject): RuntimeEvent[] {
  const itemType = stringField(item, "type") ?? "unknown";
  const itemId = stringField(item, "id");
  if (itemType === "agent_message") {
    const text = stringField(item, "text");
    if (text === undefined) return unknown("item.completed", raw);
    return [{ kind: "assistant-message", text, ...(itemId === undefined ? {} : { itemId }) }];
  }
  if (itemType === "function_call" || itemType === "tool_call") {
    const name = stringField(item, "name") ?? stringField(item, "tool_name");
    if (name === undefined) return unknown("item.completed", raw);
    const input = item["arguments"] ?? item["input"];
    return [{
      kind: "tool-call",
      name,
      ...(input === undefined ? {} : { input }),
      ...(itemId === undefined ? {} : { itemId }),
    }];
  }
  if (itemType === "function_call_output" || itemType === "tool_call_output") {
    const output = item["output"] ?? item["content"];
    return [{
      kind: "tool-result",
      ...(output === undefined ? {} : { output }),
      ...(itemId === undefined ? {} : { itemId }),
    }];
  }
  return unknown("item.completed", raw);
}

function usageFrom(raw: unknown): { readonly usage?: RuntimeTokenUsage } {
  if (!isObject(raw)) return {};
  const usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  } = {};
  const inputTokens = numberField(raw, "input_tokens");
  if (inputTokens !== undefined) usage["inputTokens"] = inputTokens;
  const cachedInputTokens = numberField(raw, "cached_input_tokens");
  if (cachedInputTokens !== undefined) usage["cachedInputTokens"] = cachedInputTokens;
  const outputTokens = numberField(raw, "output_tokens");
  if (outputTokens !== undefined) usage["outputTokens"] = outputTokens;
  const reasoningOutputTokens = numberField(raw, "reasoning_output_tokens");
  if (reasoningOutputTokens !== undefined) {
    usage["reasoningOutputTokens"] = reasoningOutputTokens;
  }
  return Object.keys(usage).length === 0 ? {} : { usage };
}

function errorMessage(raw: JsonObject): string {
  return stringField(raw, "message") ??
    stringField(raw, "error") ??
    "Codex turn failed";
}

function unknown(eventType: string, payload: unknown): RuntimeEvent[] {
  return [{ kind: "unknown", eventType, payload }];
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(obj: JsonObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(obj: JsonObject, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
