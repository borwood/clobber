import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HabitSchema, type Habit, type HabitGateDenial, type Session } from "@clobber/shared";
import type { PreToolUsePayload } from "@clobber/shared";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import { deskDirFor } from "./desk-store.ts";

// #271 habit Phase 1 — the edit-gate. A sibling of `guardOfficeBoundary`: a
// PreToolUse intercept on Write/Edit/MultiEdit targeting a desk habit file
// (`<desk>/habits/<category>/<event>/<name>.json`). It reconstructs the intended
// post-edit content, validates it against `HabitSchema`, and checks the habit's
// path is in the role's grant (presence-based: the paths the role's own habits
// already use). A violation is DENIED with Phase 0's `HabitGateDenial` shape
// (`permissionDecision:"deny"` — the ask-bridge precedent, not `{decision:"block"}`).
export interface HabitEditDeps {
  readonly sessions: SessionStore;
  readonly workspaces: WorkspaceStore;
  readonly resolveSessionHabits: (session: Session) => readonly Habit[];
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const HABIT_FILE = /\/habits\/[^/]+\/[^/]+\/[^/]+\.json$/;

export function guardHabitEdit(
  payload: PreToolUsePayload,
  deps: HabitEditDeps,
): HabitGateDenial | null {
  if (!EDIT_TOOLS.has(payload.tool_name)) return null;

  const session = deps.sessions.get(payload.session_id);
  if (session === null || session.agent_id === undefined) return null;
  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) return null;

  const filePath = stringField(payload.tool_input, "file_path");
  if (filePath === null) return null;

  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(payload.cwd, filePath);
  const deskDir = deskDirFor(workspace.repo_path, session.agent_id);
  if (!isWithin(abs, deskDir) || !HABIT_FILE.test(abs)) return null;

  const content = intendedContent(payload, abs);
  if (content === null) {
    return deny(`could not resolve the intended content of ${filePath} to validate the habit`);
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (err) {
    return deny(`habit file ${filePath} is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = HabitSchema.safeParse(value);
  if (!parsed.success) {
    return deny(
      `habit file ${filePath} does not match the habit schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }

  const granted = new Set(deps.resolveSessionHabits(session).map((h) => h.path));
  if (!granted.has(parsed.data.path)) {
    return deny(
      `your role is not granted the "${parsed.data.path}" trigger path — granted paths: ${[...granted].join(", ") || "(none)"}`,
    );
  }

  return null;
}

function deny(reason: string): HabitGateDenial {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

// The post-edit content: Write carries it whole; Edit/MultiEdit replace within
// the file on disk, so the result is the current file with the edits applied.
function intendedContent(payload: PreToolUsePayload, abs: string): string | null {
  if (payload.tool_name === "Write") return stringField(payload.tool_input, "content");

  if (!existsSync(abs)) return null;
  const current = readFileSync(abs, "utf8");

  if (payload.tool_name === "Edit") {
    const oldString = stringField(payload.tool_input, "old_string");
    const newString = stringField(payload.tool_input, "new_string");
    if (oldString === null || newString === null) return null;
    return applyEdit(current, oldString, newString, payload.tool_input["replace_all"] === true);
  }

  const edits = payload.tool_input["edits"];
  if (!Array.isArray(edits)) return null;
  let content = current;
  for (const edit of edits) {
    const oldString = stringField(edit, "old_string");
    const newString = stringField(edit, "new_string");
    if (oldString === null || newString === null) return null;
    content = applyEdit(content, oldString, newString, (edit as Record<string, unknown>)["replace_all"] === true);
  }
  return content;
}

function applyEdit(content: string, oldString: string, newString: string, all: boolean): string {
  return all ? content.split(oldString).join(newString) : content.replace(oldString, newString);
}

function stringField(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep));
}
