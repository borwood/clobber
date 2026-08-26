import { computeLineDiff, isDiffTooLarge, normalizeLines, type FileDiff } from "../file-diff.ts";
import { BoundedRaw } from "./BoundedRaw.tsx";

const DIFF_PRE_CLASS = "text-xs font-mono bg-bg border border-border rounded p-2 overflow-x-auto";

// Renders an Edit/Write tool call as a colored diff (#684) — the seam that
// makes "watching a worker code" legible without expanding show-details.
export function FileDiffBlock({ diff }: { diff: FileDiff }) {
  return (
    <div className="mt-1 space-y-1">
      <div className="text-text-dim font-mono text-xs truncate">{diff.filePath}</div>
      {diff.kind === "edit" ? (
        <DiffLines diff={diff} />
      ) : (
        <LinesBlock text={diff.content} type="add" />
      )}
    </div>
  );
}

// Above the size guard, a full LCS would freeze the tab on a huge Edit
// (thousands of lines on each side) — fall back to a bounded remove-all/
// add-all view instead, the same shape a Write renders.
function DiffLines({ diff }: { diff: Extract<FileDiff, { kind: "edit" }> }) {
  const oldLines = normalizeLines(diff.oldString);
  const newLines = normalizeLines(diff.newString);
  if (isDiffTooLarge(oldLines, newLines)) {
    return (
      <div className="space-y-1">
        <LinesBlock text={diff.oldString} type="remove" />
        <LinesBlock text={diff.newString} type="add" />
      </div>
    );
  }
  const lines = computeLineDiff(diff.oldString, diff.newString);
  return (
    <pre className={DIFF_PRE_CLASS}>
      {lines.map((line, i) => (
        <div key={i} data-diff-line={line.type} className={diffLineClass(line.type)}>
          {diffLinePrefix(line.type)}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

// A single-color block of lines — all-added (Write, and the oversized-diff
// fallback's new_string) or all-removed (the oversized-diff fallback's
// old_string). Composes BoundedRaw's truncate/expand (cf. #673) instead of
// reimplementing it: BoundedRaw caps the char count, this only decides how
// the (possibly truncated) text renders per line.
function LinesBlock({ text, type }: { text: string; type: "add" | "remove" }) {
  return (
    <BoundedRaw
      text={text}
      render={(displayed) => (
        <pre className={DIFF_PRE_CLASS}>
          {normalizeLines(displayed).map((line, i) => (
            <div key={i} data-diff-line={type} className={diffLineClass(type)}>
              {diffLinePrefix(type)}
              {line}
            </div>
          ))}
        </pre>
      )}
    />
  );
}

function diffLineClass(type: "context" | "add" | "remove"): string {
  if (type === "add") return "text-diff-add bg-diff-add-bg";
  if (type === "remove") return "text-diff-remove bg-diff-remove-bg";
  return "text-text-soft";
}

function diffLinePrefix(type: "context" | "add" | "remove"): string {
  if (type === "add") return "+ ";
  if (type === "remove") return "- ";
  return "  ";
}
