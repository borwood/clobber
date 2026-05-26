import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { PostToolUsePayload } from "@clobber/shared";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

// Advisory PostToolUse reminder, fed back to the agent as additionalContext.
// PostToolUse can't gate the write — the file is already on disk — so this is
// purely a nudge (Golden Rule 3: surface loudly, don't swallow/gate).
export interface FileSizeReminder {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PostToolUse";
    readonly additionalContext: string;
  };
}

export interface FileSizeReminderDeps {
  readonly sessions: SessionStore;
  readonly workspaces: WorkspaceStore;
}

// Only Edit/Write touch a single file we can re-measure. Both carry the path
// under tool_input.file_path.
const EDIT_TOOLS = new Set(["Edit", "Write"]);

const FilePathInputSchema = z.object({ file_path: z.string().min(1) });

// Source extensions worth holding to the ceiling. Markdown/JSON/lockfiles are
// excluded by omission — they're legitimately large and not the target of the
// "split by responsibility" nudge.
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java", "rb", "c", "h", "cpp", "cc", "cs",
  "swift", "kt", "scala", "sh", "css", "scss",
]);

// Path markers that flag a file as a test/fixture — legitimately large, so the
// nudge stays off (matches the assignment's "exclude tests, markdown, fixtures").
const EXCLUDED_MARKERS = [
  ".test.", ".spec.", "/tests/", "/test/", "/__tests__/",
  "/fixtures/", "/__fixtures__/", "/__mocks__/",
];

export function buildFileSizeReminder(
  payload: PostToolUsePayload,
  deps: FileSizeReminderDeps,
): FileSizeReminder | null {
  if (!EDIT_TOOLS.has(payload.tool_name)) return null;

  const session = deps.sessions.get(payload.session_id);
  if (session === null) return null;
  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) return null;

  const policy = workspace.file_size_policy;
  if (policy.kind === "off") return null;

  const input = FilePathInputSchema.safeParse(payload.tool_input);
  if (!input.success) return null;
  const filePath = input.data.file_path;

  if (!isCodeFile(filePath)) return null;

  const abs = isAbsolute(filePath) ? filePath : resolve(payload.cwd, filePath);
  if (!existsSync(abs)) return null;
  const lineCount = countLines(readFileSync(abs, "utf8"));

  if (lineCount <= policy.max_lines) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: renderReminder(basename(filePath), lineCount, policy.max_lines),
    },
  };
}

function isCodeFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (EXCLUDED_MARKERS.some((m) => normalized.includes(m))) return false;
  const ext = normalized.slice(normalized.lastIndexOf(".") + 1).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

// wc -l semantics: count lines, not the trailing-newline empty segment.
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const segments = text.split("\n").length;
  return text.endsWith("\n") ? segments - 1 : segments;
}

function renderReminder(name: string, lineCount: number, maxLines: number): string {
  return `\`${name}\` is now ${lineCount} lines, over the ${maxLines}-line ceiling — consider splitting it by responsibility.`;
}
