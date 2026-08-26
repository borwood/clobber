// Detects Edit/Write tool calls by name + input shape and computes the tiny
// line-diff for Edit blocks (#684). The two strings an Edit call carries ARE
// the diff — no dependency needed, just an LCS-based line matcher scoped to
// the (typically small) old/new snippet, not a whole-file diff.

export type FileDiff =
  | { readonly kind: "edit"; readonly filePath: string; readonly oldString: string; readonly newString: string }
  | { readonly kind: "write"; readonly filePath: string; readonly content: string };

const EDIT_TOOL_NAMES = new Set(["Edit", "str_replace_editor"]);
const WRITE_TOOL_NAMES = new Set(["Write"]);

// Detects an Edit/Write call by tool name AND input shape together — a
// same-named tool from a different source with a different input shape falls
// through to the generic card rather than rendering a bogus diff.
export function detectFileDiff(name: string, input: unknown): FileDiff | null {
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, unknown>;
  const filePath = obj["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) return null;

  if (EDIT_TOOL_NAMES.has(name)) {
    const oldString = obj["old_string"];
    const newString = obj["new_string"];
    if (typeof oldString === "string" && typeof newString === "string") {
      return { kind: "edit", filePath, oldString, newString };
    }
    return null;
  }

  if (WRITE_TOOL_NAMES.has(name)) {
    const content = obj["content"];
    if (typeof content === "string") {
      return { kind: "write", filePath, content };
    }
    return null;
  }

  return null;
}

export type DiffLine = { readonly type: "context" | "add" | "remove"; readonly text: string };

// Splits a string into lines for diffing/rendering. `\r\n` is normalized to
// `\n` first so CRLF text (Windows-authored files) doesn't leave a trailing
// `\r` on every line — without this, identical lines never match by `===`
// and the whole diff renders as remove+add instead of context. An empty
// string is zero lines (not one empty line): a deletion's new_string="" must
// not render a spurious trailing blank "add" line.
export function normalizeLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

// A diff whose line-count product would blow up the O(n*m) LCS matrix (or
// whose total line count would dump too many DOM nodes at once) is too large
// to compute/render inline — the caller should fall back to a bounded
// all-removed/all-added view instead (cf. WriteDiff in DiffBlock.tsx).
export const MAX_DIFF_CELLS = 250_000;
export const MAX_DIFF_LINES = 4_000;

export function isDiffTooLarge(
  oldLines: readonly string[],
  newLines: readonly string[],
): boolean {
  return oldLines.length * newLines.length > MAX_DIFF_CELLS || oldLines.length + newLines.length > MAX_DIFF_LINES;
}

// Line-level LCS diff. Quadratic in line count — callers must guard with
// isDiffTooLarge first; this function does not check the cap itself.
export function computeLineDiff(oldStr: string, newStr: string): readonly DiffLine[] {
  const oldLines = normalizeLines(oldStr);
  const newLines = normalizeLines(newStr);
  const n = oldLines.length;
  const m = newLines.length;

  // lcs[i][j] = length of the LCS of oldLines[i:] and newLines[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "context", text: oldLines[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      result.push({ type: "remove", text: oldLines[i]! });
      i++;
    } else {
      result.push({ type: "add", text: newLines[j]! });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "remove", text: oldLines[i]! });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", text: newLines[j]! });
    j++;
  }
  return result;
}
