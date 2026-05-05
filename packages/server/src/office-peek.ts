import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface OfficePeek {
  readonly file_count: number;
  readonly latest: {
    readonly name: string;
    readonly mtime_ms: number;
    readonly preview: string;
  } | null;
}

export interface PeekOfficeOptions {
  readonly previewBytes?: number;
}

export function peekOffice(officeDir: string, opts?: PeekOfficeOptions): OfficePeek {
  if (!existsSync(officeDir)) return { file_count: 0, latest: null };

  const previewBytes =
    opts === undefined || opts.previewBytes === undefined ? 800 : opts.previewBytes;

  const entries = readdirSync(officeDir, { withFileTypes: true });
  const notes: { name: string; mtimeMs: number }[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const stat = statSync(join(officeDir, e.name));
    notes.push({ name: e.name, mtimeMs: stat.mtimeMs });
  }
  notes.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
  });

  if (notes.length === 0) return { file_count: 0, latest: null };

  const newest = notes[0]!;
  const buf = readFileSync(join(officeDir, newest.name));
  const preview = buf.subarray(0, previewBytes).toString("utf8");

  return {
    file_count: notes.length,
    latest: {
      name: newest.name,
      mtime_ms: newest.mtimeMs,
      preview,
    },
  };
}
