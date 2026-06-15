export type TranscriptLine = Record<string, unknown>;

export interface TranscriptFetchResponse {
  readonly lines: readonly TranscriptLine[];
  readonly cursor: number;
}

interface UsageBlock {
  readonly input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

// Returns the context length from the latest assistant turn's usage tokens:
// input + cache_read + cache_creation. Undefined when no assistant turn with
// a usage block exists yet (e.g. session just started).
export function computeContextLength(lines: readonly TranscriptLine[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line["type"] !== "assistant") continue;
    const msg = line["message"];
    if (msg === null || typeof msg !== "object") continue;
    const usage = (msg as Record<string, unknown>)["usage"];
    if (usage === null || typeof usage !== "object") continue;
    const u = usage as UsageBlock;
    const input = u.input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheCreate = u.cache_creation_input_tokens ?? 0;
    return input + cacheRead + cacheCreate;
  }
  return undefined;
}
