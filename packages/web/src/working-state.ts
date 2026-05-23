import type { TranscriptLine } from "./api.ts";
import { classifyLine, parseTimestamp, type Classified } from "./transcript-types.ts";

// Live, turn-level summary rendered beneath the transcript while the agent's
// turn is in flight — verb (what it's doing right now), how long the turn has
// run, and tokens generated this turn. All three are derived from the polled
// transcript; the caller decides when to show it (busy === true).
export interface WorkingState {
  readonly verb: string;
  readonly startMs: number | null;
  readonly outputTokens: number;
}

// Most-recent message type → present-tense verb. The headline default reflects
// the product ("Clobbering"); specific activities specialize it.
const TOOL_VERBS: Record<string, string> = {
  Bash: "Running",
  Read: "Reading",
  Edit: "Editing",
  Write: "Editing",
  MultiEdit: "Editing",
  NotebookEdit: "Editing",
  Grep: "Searching",
  Glob: "Searching",
  WebFetch: "Searching",
  WebSearch: "Searching",
  Task: "Delegating",
  Agent: "Delegating",
  TodoWrite: "Planning",
  AskUserQuestion: "Asking",
};

const DEFAULT_VERB = "Clobbering";

function verbFor(last: Classified | undefined): string {
  if (last === undefined) return DEFAULT_VERB;
  if (last.kind === "thinking-pulse") return "Thinking";
  // A trailing tool_result-only user line means the agent is chewing on tool
  // output, deciding its next move.
  if (last.kind === "system" && last.type === "tool_result") return "Thinking";
  if (last.kind === "assistant") {
    const blocks = last.line.message.content;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block !== undefined && block.type === "tool_use") {
        const verb = TOOL_VERBS[block.name];
        return verb === undefined ? DEFAULT_VERB : verb;
      }
    }
    if (blocks.some((b) => b.type === "text" && b.text.trim().length > 0)) {
      return "Writing";
    }
  }
  return DEFAULT_VERB;
}

// output_tokens lives on assistant lines' `message.usage`. Transcript lines are
// heterogeneous raw records — user/system lines carry no usage — so a line
// without it contributes nothing rather than being an error.
function readOutputTokens(line: TranscriptLine | undefined): number {
  if (line === undefined || line["type"] !== "assistant") return 0;
  const message = line["message"];
  if (message === null || typeof message !== "object") return 0;
  const usage = (message as Record<string, unknown>)["usage"];
  if (usage === null || typeof usage !== "object") return 0;
  const out = (usage as Record<string, unknown>)["output_tokens"];
  return typeof out === "number" ? out : 0;
}

export function deriveWorkingState(lines: readonly TranscriptLine[]): WorkingState {
  const classified = lines.map(classifyLine);

  let last: Classified | undefined;
  for (let i = classified.length - 1; i >= 0; i--) {
    const c = classified[i];
    if (c !== undefined && c.kind !== "filtered") {
      last = c;
      break;
    }
  }

  // The current turn starts at the most recent real user prompt — tool_result
  // user lines (kind "system") don't reset the clock.
  let promptIdx = -1;
  for (let i = classified.length - 1; i >= 0; i--) {
    if (classified[i]?.kind === "user") {
      promptIdx = i;
      break;
    }
  }

  const startMs = promptIdx >= 0 ? parseTimestamp(lines[promptIdx]?.["timestamp"]) : null;

  let outputTokens = 0;
  for (let i = promptIdx + 1; i < lines.length; i++) {
    outputTokens += readOutputTokens(lines[i]);
  }

  return { verb: verbFor(last), startMs, outputTokens };
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}
