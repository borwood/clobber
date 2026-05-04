import type { TranscriptLine } from "./transcript-reader.ts";

export type Detail = "low" | "medium" | "full";

export type SelectionKind = "default" | "last" | "entry" | "from" | "to";

export type Selection =
  | { readonly kind: "default"; readonly n: number }
  | { readonly kind: "last"; readonly n: number }
  | { readonly kind: "entry"; readonly id: string }
  | { readonly kind: "from"; readonly id: string; readonly limit: number }
  | { readonly kind: "to"; readonly id: string; readonly limit: number };

export interface FormattedEntry {
  readonly id: string;
  readonly type: string;
  readonly role?: "user" | "assistant";
  readonly content?: string;
  readonly summary?: string;
  readonly payload?: Record<string, unknown>;
}

export interface FormattedTranscript {
  readonly total: number;
  readonly selection: Selection;
  readonly entries: readonly FormattedEntry[];
}

const SUMMARY_INPUT_LIMIT = 80;

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
  readonly content?: string | readonly ContentBlock[];
}

interface MessageShape {
  readonly role?: "user" | "assistant";
  readonly content?: string | readonly ContentBlock[];
}

interface ClassifiedMessage {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  readonly content: string;
}
interface ClassifiedEvent {
  readonly kind: "event";
  readonly summary: string;
}
type Classified = ClassifiedMessage | ClassifiedEvent;

function topLevelType(line: TranscriptLine): string {
  const t = line["type"];
  return typeof t === "string" ? t : "unknown";
}

function readMessage(line: TranscriptLine): MessageShape | null {
  const m = line["message"];
  if (m === null || typeof m !== "object") return null;
  return m as MessageShape;
}

function pureTextContent(blocks: readonly ContentBlock[]): string | null {
  let text = "";
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") return null;
    text += b.text;
  }
  return text;
}

function summarizeAssistantBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "?";
      const inputStr = b.input === undefined ? "" : truncate(stringifyInput(b.input));
      parts.push(`[tool_use ${name}] ${inputStr}`.trimEnd());
    } else if (b.type === "text" && typeof b.text === "string") {
      parts.push(`[text] ${truncate(b.text.replace(/\s+/g, " "))}`);
    } else {
      parts.push(`[${b.type}]`);
    }
  }
  return parts.join(" ");
}

function summarizeUserBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "tool_result") {
      const c = b.content;
      const lineCount = typeof c === "string" ? c.split("\n").length : 0;
      parts.push(`[tool_result] ${lineCount} line${lineCount === 1 ? "" : "s"}`);
    } else {
      parts.push(`[${b.type}]`);
    }
  }
  return parts.join(" ");
}

function stringifyInput(input: Record<string, unknown>): string {
  if ("command" in input && typeof input["command"] === "string") return input["command"];
  return JSON.stringify(input);
}

function truncate(s: string): string {
  if (s.length <= SUMMARY_INPUT_LIMIT) return s;
  return s.slice(0, SUMMARY_INPUT_LIMIT - 1) + "…";
}

function classify(line: TranscriptLine): Classified {
  const type = topLevelType(line);
  if (type === "user" || type === "assistant") {
    const msg = readMessage(line);
    if (msg !== null) {
      const role = msg.role === "user" || msg.role === "assistant" ? msg.role : null;
      const content = msg.content;
      if (role !== null && typeof content === "string") {
        return { kind: "message", role, content };
      }
      if (role !== null && Array.isArray(content)) {
        const text = pureTextContent(content);
        if (text !== null) {
          return { kind: "message", role, content: text };
        }
        const summary = role === "assistant"
          ? summarizeAssistantBlocks(content)
          : summarizeUserBlocks(content);
        return { kind: "event", summary };
      }
    }
  }
  return { kind: "event", summary: `[${type}]` };
}

function formatEntry(line: TranscriptLine, id: string, detail: Detail): FormattedEntry | null {
  const type = topLevelType(line);
  if (detail === "full") {
    return { id, type, payload: line as Record<string, unknown> };
  }
  const c = classify(line);
  if (detail === "low") {
    if (c.kind !== "message") return null;
    return { id, type, role: c.role, content: c.content };
  }
  if (c.kind === "message") {
    return { id, type, role: c.role, content: c.content };
  }
  return { id, type, summary: c.summary };
}

export function formatTranscript(
  lines: readonly TranscriptLine[],
  selection: Selection,
  detail: Detail,
): FormattedTranscript {
  const total = lines.length;
  const ids = lines.map((_, i) => i.toString());
  const slice = applySelection(lines, ids, selection);
  const entries: FormattedEntry[] = [];
  for (const { line, id } of slice) {
    const e = formatEntry(line, id, detail);
    if (e !== null) entries.push(e);
  }
  return { total, selection, entries };
}

interface IndexedLine {
  readonly line: TranscriptLine;
  readonly id: string;
}

function applySelection(
  lines: readonly TranscriptLine[],
  ids: readonly string[],
  selection: Selection,
): readonly IndexedLine[] {
  const all: IndexedLine[] = lines.map((line, i) => ({ line, id: ids[i]! }));
  if (selection.kind === "entry") {
    const idx = parseIndex(selection.id, lines.length);
    return idx === null ? [] : [all[idx]!];
  }
  if (selection.kind === "from") {
    const idx = parseIndex(selection.id, lines.length);
    if (idx === null) return [];
    return all.slice(idx, idx + selection.limit);
  }
  if (selection.kind === "to") {
    const idx = parseIndex(selection.id, lines.length);
    if (idx === null) return [];
    const start = Math.max(0, idx - selection.limit + 1);
    return all.slice(start, idx + 1);
  }
  const n = selection.kind === "default" ? selection.n : selection.n;
  const start = Math.max(0, all.length - n);
  return all.slice(start);
}

function parseIndex(id: string, length: number): number | null {
  if (!/^\d+$/.test(id)) return null;
  const n = Number.parseInt(id, 10);
  if (n < 0 || n >= length) return null;
  return n;
}

export function isValidEntryId(id: string, length: number): boolean {
  return parseIndex(id, length) !== null;
}

export interface TranscriptQuery {
  readonly last?: string;
  readonly entry?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: string;
  readonly detail?: string;
}

export type ParseQueryResult =
  | { readonly ok: true; readonly selection: Selection; readonly detail: Detail }
  | { readonly ok: false; readonly error: string };

const DEFAULT_N = 20;
const DEFAULT_LIMIT = 20;

export function parseTranscriptQuery(q: TranscriptQuery): ParseQueryResult {
  const detail = q.detail === undefined ? "medium" : q.detail;
  if (detail !== "low" && detail !== "medium" && detail !== "full") {
    return { ok: false, error: `invalid detail: ${detail}` };
  }
  const selectors = [q.last, q.entry, q.from, q.to].filter((v) => v !== undefined);
  if (selectors.length > 1) {
    return { ok: false, error: "only one selector may be set (--last|--entry|--from|--to)" };
  }
  if (q.last !== undefined) {
    const n = parsePositive(q.last);
    if (n === null) return { ok: false, error: `invalid last: ${q.last}` };
    return { ok: true, selection: { kind: "last", n }, detail };
  }
  if (q.entry !== undefined) {
    if (q.limit !== undefined) {
      return { ok: false, error: "--limit is not allowed with --entry" };
    }
    return { ok: true, selection: { kind: "entry", id: q.entry }, detail };
  }
  if (q.from !== undefined) {
    const limit = q.limit === undefined ? DEFAULT_LIMIT : parsePositive(q.limit);
    if (limit === null) return { ok: false, error: `invalid limit: ${q.limit}` };
    return { ok: true, selection: { kind: "from", id: q.from, limit }, detail };
  }
  if (q.to !== undefined) {
    const limit = q.limit === undefined ? DEFAULT_LIMIT : parsePositive(q.limit);
    if (limit === null) return { ok: false, error: `invalid limit: ${q.limit}` };
    return { ok: true, selection: { kind: "to", id: q.to, limit }, detail };
  }
  return { ok: true, selection: { kind: "default", n: DEFAULT_N }, detail };
}

function parsePositive(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return n > 0 ? n : null;
}
