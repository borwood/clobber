// The single source of truth for "apply a markdown style to a selection".
// Both the toolbar buttons and the keyboard shortcuts project onto this — given
// the current document + selection it returns a set of CodeMirror-shaped change
// specs plus the resulting selection, so callers never re-implement the wrap /
// unwrap / line-prefix arithmetic. Kept pure (string in, change-spec out) so it
// is fully unit-testable without an EditorView.

export type InlineFormat = "bold" | "italic" | "strikethrough" | "code";
export type LineFormat = "heading" | "quote" | "bullet" | "ordered";
export type MarkdownFormat = InlineFormat | LineFormat;

export interface SelectionRange {
  readonly from: number;
  readonly to: number;
}

export interface ChangeSpec {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface FormatChange {
  readonly changes: readonly ChangeSpec[];
  readonly selection: SelectionRange;
}

const INLINE_MARKERS: Record<InlineFormat, string> = {
  bold: "**",
  italic: "*",
  strikethrough: "~~",
  code: "`",
};

const LINE_PREFIXES: Record<LineFormat, string> = {
  heading: "# ",
  quote: "> ",
  bullet: "- ",
  ordered: "1. ",
};

const INLINE_FORMATS = new Set<MarkdownFormat>(["bold", "italic", "strikethrough", "code"]);

export function computeFormat(
  doc: string,
  sel: SelectionRange,
  format: MarkdownFormat,
): FormatChange {
  if (INLINE_FORMATS.has(format)) {
    return computeInline(doc, sel, INLINE_MARKERS[format as InlineFormat]);
  }
  return computeLine(doc, sel, LINE_PREFIXES[format as LineFormat]);
}

function computeInline(doc: string, sel: SelectionRange, marker: string): FormatChange {
  const { from, to } = sel;
  const len = marker.length;
  const selected = doc.slice(from, to);

  // Markers sitting just outside the selection — toggle them off.
  if (doc.slice(from - len, from) === marker && doc.slice(to, to + len) === marker) {
    return {
      changes: [
        { from: from - len, to: from, insert: "" },
        { from: to, to: to + len, insert: "" },
      ],
      selection: { from: from - len, to: to - len },
    };
  }

  // Selection already contains its own markers — toggle them off.
  if (selected.length >= 2 * len && selected.startsWith(marker) && selected.endsWith(marker)) {
    return {
      changes: [{ from, to, insert: selected.slice(len, selected.length - len) }],
      selection: { from, to: to - 2 * len },
    };
  }

  // Empty selection — drop an empty pair and park the caret inside it.
  if (from === to) {
    return {
      changes: [{ from, to, insert: marker + marker }],
      selection: { from: from + len, to: from + len },
    };
  }

  // Wrap the selection.
  return {
    changes: [{ from, to, insert: marker + selected + marker }],
    selection: { from: from + len, to: to + len },
  };
}

interface LineInfo {
  readonly start: number;
  readonly text: string;
}

function linesInRange(doc: string, from: number, to: number): LineInfo[] {
  const lines: LineInfo[] = [];
  let lineStart = 0;
  const parts = doc.split("\n");
  for (const text of parts) {
    const lineEnd = lineStart + text.length;
    // Include a line when the selection touches it; a zero-width caret at a
    // line's start still selects that line.
    if (lineStart <= to && lineEnd >= from) {
      lines.push({ start: lineStart, text });
    }
    lineStart = lineEnd + 1; // account for the "\n"
  }
  return lines;
}

function computeLine(doc: string, sel: SelectionRange, prefix: string): FormatChange {
  const lines = linesInRange(doc, sel.from, sel.to);
  const allPrefixed = lines.every((l) => l.text.startsWith(prefix));

  const changes: ChangeSpec[] = [];
  const shifts: { readonly pos: number; readonly delta: number }[] = [];
  for (const line of lines) {
    if (allPrefixed) {
      changes.push({ from: line.start, to: line.start + prefix.length, insert: "" });
      shifts.push({ pos: line.start, delta: -prefix.length });
    } else if (!line.text.startsWith(prefix)) {
      changes.push({ from: line.start, to: line.start, insert: prefix });
      shifts.push({ pos: line.start, delta: prefix.length });
    }
  }

  return {
    changes,
    selection: {
      from: shiftOffset(sel.from, shifts),
      to: shiftOffset(sel.to, shifts),
    },
  };
}

// Shift an absolute offset by every edit that lands at or before it. A deletion
// at a line start (pos) only moves an offset that sits past the removed prefix.
function shiftOffset(offset: number, shifts: readonly { pos: number; delta: number }[]): number {
  let result = offset;
  for (const { pos, delta } of shifts) {
    if (delta > 0) {
      if (pos <= offset) result += delta;
    } else if (pos < offset) {
      result += Math.max(delta, pos - offset);
    }
  }
  return result;
}
