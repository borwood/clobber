import { useState } from "react";
import { computeLineDiff, type FileDiff } from "../file-diff.ts";
import { CAP_CHARS } from "./BoundedRaw.tsx";

// Renders an Edit/Write tool call as a colored diff (#684) — the seam that
// makes "watching a worker code" legible without expanding show-details.
export function FileDiffBlock({ diff }: { diff: FileDiff }) {
  return (
    <div className="mt-1 space-y-1">
      <div className="text-text-dim font-mono text-xs truncate">{diff.filePath}</div>
      {diff.kind === "edit" ? (
        <DiffLines diff={diff} />
      ) : (
        <WriteDiff content={diff.content} />
      )}
    </div>
  );
}

function DiffLines({ diff }: { diff: Extract<FileDiff, { kind: "edit" }> }) {
  const lines = computeLineDiff(diff.oldString, diff.newString);
  return (
    <pre className="text-xs font-mono bg-bg border border-border rounded p-2 overflow-x-auto">
      {lines.map((line, i) => (
        <div key={i} data-diff-line={line.type} className={diffLineClass(line.type)}>
          {diffLinePrefix(line.type)}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

// Write has no "before" — every line is an addition, rendered with the same
// data-diff-line markup as an Edit's added lines. Bounded the same way
// BoundedRaw bounds any other large payload (cf. #673): truncate the char
// count with a "show full" expand, applied before splitting into lines so a
// huge Write can't render thousands of DOM nodes up front.
function WriteDiff({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = !expanded && content.length > CAP_CHARS;
  const displayed = truncated ? content.slice(0, CAP_CHARS) : content;
  const lines = displayed.split("\n");
  return (
    <div>
      <pre className="text-xs font-mono bg-bg border border-border rounded p-2 overflow-x-auto">
        {lines.map((text, i) => (
          <div key={i} data-diff-line="add" className="text-diff-add bg-diff-add-bg">
            {"+ "}
            {text}
          </div>
        ))}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-[10px] text-text-subtle hover:text-text-soft underline"
        >
          show full ({Math.ceil(content.length / 1024)} KB)
        </button>
      )}
    </div>
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
