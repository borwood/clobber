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

// Line-level LCS diff. Quadratic in line count, which is fine for an Edit
// call's old/new snippet (a localized region of one file, not a whole file).
export function computeLineDiff(oldStr: string, newStr: string): readonly DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
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
