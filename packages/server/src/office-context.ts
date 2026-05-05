import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ComposeOfficeContextOptions {
  readonly maxFiles?: number;
  readonly previewBytes?: number;
  readonly now?: number;
}

interface NoteEntry {
  readonly name: string;
  readonly mtimeMs: number;
}

function listNotes(officeDir: string): readonly NoteEntry[] {
  const entries = readdirSync(officeDir, { withFileTypes: true });
  const notes: NoteEntry[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const stat = statSync(join(officeDir, e.name));
    notes.push({ name: e.name, mtimeMs: stat.mtimeMs });
  }
  notes.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
  });
  return notes;
}

function relativeTime(now: number, then: number): string {
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function headPreview(path: string, previewBytes: number): string {
  const buf = readFileSync(path);
  return buf.subarray(0, previewBytes).toString("utf8");
}

export function composeOfficeContext(
  officeDir: string,
  opts?: ComposeOfficeContextOptions,
): string {
  const maxFiles = opts === undefined || opts.maxFiles === undefined ? 5 : opts.maxFiles;
  const previewBytes =
    opts === undefined || opts.previewBytes === undefined ? 800 : opts.previewBytes;
  const now = opts === undefined || opts.now === undefined ? Date.now() : opts.now;

  const notes = listNotes(officeDir);
  const lines: string[] = ["[Previously in this office]"];

  if (notes.length === 0) {
    lines.push(
      "office is empty — leave notes for your future self before this session ends.",
    );
    lines.push("[End of previously]");
    return lines.join("\n");
  }

  const visible = notes.slice(0, maxFiles);
  for (let i = 0; i < visible.length; i++) {
    const note = visible[i]!;
    const rel = relativeTime(now, note.mtimeMs);
    lines.push(`- ${note.name} (${rel})`);
    if (i === 0) {
      const preview = headPreview(join(officeDir, note.name), previewBytes);
      const indented = preview
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      lines.push("  preview:");
      lines.push(indented);
    }
  }

  lines.push("[End of previously]");
  return lines.join("\n");
}
