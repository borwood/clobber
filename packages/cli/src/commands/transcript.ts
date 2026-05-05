import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface TranscriptEntry {
  readonly id: string;
  readonly type: string;
  readonly role?: "user" | "assistant";
  readonly content?: string;
  readonly summary?: string;
  readonly payload?: Record<string, unknown>;
}

interface TranscriptResponse {
  readonly total: number;
  readonly selection: { readonly kind: string; readonly [key: string]: unknown };
  readonly entries: readonly TranscriptEntry[];
}

interface ParsedFlags {
  readonly sessionId: string;
  readonly query: string;
  readonly format: "text" | "json";
}

const SELECTORS = ["--last", "--entry", "--from", "--to"] as const;

function parseFlags(args: readonly string[]): ParsedFlags {
  const [sessionId, ...rest] = args;
  if (sessionId === undefined) {
    throw new CliUsageError("transcript: missing session id (usage: `transcript <session-id> [flags]`)");
  }
  const query: string[] = [];
  let format: "text" | "json" = "text";
  let selectorCount = 0;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === undefined) break;
    const value = rest[i + 1];
    if (flag === "--format") {
      if (value !== "text" && value !== "json") {
        throw new CliUsageError("transcript: --format must be 'text' or 'json'");
      }
      format = value;
      i += 1;
      continue;
    }
    if (flag === "--detail" || flag === "-d") {
      if (value !== "low" && value !== "medium" && value !== "full") {
        throw new CliUsageError("transcript: --detail must be 'low', 'medium', or 'full'");
      }
      query.push(`detail=${value}`);
      i += 1;
      continue;
    }
    if (flag === "--limit") {
      if (value === undefined) throw new CliUsageError("transcript: --limit needs a value");
      query.push(`limit=${encodeURIComponent(value)}`);
      i += 1;
      continue;
    }
    if ((SELECTORS as readonly string[]).includes(flag)) {
      if (value === undefined) throw new CliUsageError(`transcript: ${flag} needs a value`);
      selectorCount += 1;
      if (selectorCount > 1) {
        throw new CliUsageError(
          "transcript: only one selector may be set (--last|--entry|--from|--to)",
        );
      }
      query.push(`${flag.slice(2)}=${encodeURIComponent(value)}`);
      i += 1;
      continue;
    }
    throw new CliUsageError(`transcript: unknown flag: ${flag}`);
  }

  return { sessionId, query: query.join("&"), format };
}

function renderText(t: TranscriptResponse): string {
  const lines: string[] = [];
  lines.push(`# transcript (${t.entries.length}/${t.total} entries — ${t.selection.kind})`);
  for (const e of t.entries) {
    if (e.payload !== undefined) {
      lines.push("");
      lines.push(`--- [${e.id}] ${e.type} ---`);
      lines.push(JSON.stringify(e.payload, null, 2));
      continue;
    }
    if (e.role !== undefined && e.content !== undefined) {
      lines.push("");
      lines.push(`--- [${e.id}] ${e.role} ---`);
      lines.push(e.content);
      continue;
    }
    if (e.summary !== undefined) {
      lines.push(`[${e.id}] ${e.summary}`);
      continue;
    }
    lines.push(`[${e.id}] ${e.type}`);
  }
  lines.push("");
  return lines.join("\n");
}

const TRANSCRIPT_USAGE = `usage: clobber transcript <session-id> [selector] [--detail <level>] [--limit <n>] [--format <text|json>]

Read a session transcript with selectors and detail levels.

Selectors (mutually exclusive — pick at most one):
  --last <n>     Show the last N entries.
  --entry <id>   Show the single entry with this id.
  --from <id>    Show entries starting at this id (inclusive).
  --to <id>      Show entries up to this id (inclusive).

Flags:
  --detail <low|medium|full>  How much payload to include per entry (alias: -d).
  --limit <n>                 Cap the number of returned entries.
  --format <text|json>        Output format (default: text).

Example:
  clobber transcript 0b2f4e1a-... --last 20 --detail medium

Skill: see manager:transcript for selector strategy and investigation patterns.`;

export const transcriptCommand: Command = {
  name: "transcript",
  summary: "Read a session transcript with selectors and detail levels.",
  usage: TRANSCRIPT_USAGE,
  async run(ctx) {
    const flags = parseFlags(ctx.args);
    const path = `/agent/sessions/${encodeURIComponent(flags.sessionId)}/transcript${
      flags.query.length === 0 ? "" : `?${flags.query}`
    }`;
    const result = await request<TranscriptResponse>(ctx.env, { method: "GET", path });
    if (flags.format === "json") {
      ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      ctx.stdout.write(renderText(result));
    }
    return 0;
  },
};
