export type RuntimeEvent =
  | RuntimeProviderThreadStarted
  | RuntimeTurnStarted
  | RuntimeAssistantMessage
  | RuntimeToolCall
  | RuntimeToolResult
  | RuntimeTurnCompleted
  | RuntimeTurnFailed
  | RuntimeUnknownEvent;

export interface RuntimeProviderThreadStarted {
  readonly kind: "provider-thread-started";
  readonly providerThreadId: string;
}

export interface RuntimeTurnStarted {
  readonly kind: "turn-started";
}

export interface RuntimeAssistantMessage {
  readonly kind: "assistant-message";
  readonly text: string;
  readonly itemId?: string;
}

export interface RuntimeToolCall {
  readonly kind: "tool-call";
  readonly name: string;
  readonly input?: unknown;
  readonly itemId?: string;
}

export interface RuntimeToolResult {
  readonly kind: "tool-result";
  readonly output?: unknown;
  readonly itemId?: string;
}

export interface RuntimeTurnCompleted {
  readonly kind: "turn-completed";
  readonly usage?: RuntimeTokenUsage;
}

export interface RuntimeTurnFailed {
  readonly kind: "turn-failed";
  readonly message: string;
}

export interface RuntimeUnknownEvent {
  readonly kind: "unknown";
  readonly eventType: string;
  readonly payload: unknown;
}

export interface RuntimeTokenUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}
