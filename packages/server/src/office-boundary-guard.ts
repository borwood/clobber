import { resolve } from "node:path";
import type { PreToolUsePayload } from "@clobber/shared";
import type { RoleStore } from "./role-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import {
  isWithin,
  resolveToolPath,
  hasWriteIntent,
  extractBashWriteTargets,
} from "./tool-write-targets.ts";

export const OFFICE_BOUNDARY_DENIAL =
  "office writes are restricted to your own office: $CLOBBER_OFFICE_DIR";

export interface HookDenial {
  readonly decision: "block";
  readonly reason: string;
}

export interface OfficeBoundaryDeps {
  readonly sessions: SessionStore;
  readonly workspaces: WorkspaceStore;
  readonly roles: RoleStore;
}

export function guardOfficeBoundary(
  payload: PreToolUsePayload,
  deps: OfficeBoundaryDeps,
): HookDenial | null {
  const targets = officeWriteTargets(payload);
  if (targets.length === 0) return null;

  const session = deps.sessions.get(payload.session_id);
  if (session === null) return null;

  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) return null;

  const role = deps.roles.get(session.role_id);
  const hasOffice = role?.persistent === true;
  const officesRoot = resolve(workspace.repo_path, ".clobber", "offices");
  const allowedOffice =
    hasOffice && session.agent_id !== undefined
      ? resolve(officesRoot, session.agent_id)
      : null;

  for (const target of targets) {
    const resolved = resolveToolPath(target, payload.cwd);
    if (!isWithin(resolved, officesRoot)) continue;
    if (allowedOffice !== null && isWithin(resolved, allowedOffice)) continue;
    return { decision: "block", reason: OFFICE_BOUNDARY_DENIAL };
  }

  return null;
}

function officeWriteTargets(payload: PreToolUsePayload): string[] {
  const input = payload.tool_input;

  if (
    payload.tool_name === "Write" ||
    payload.tool_name === "Edit" ||
    payload.tool_name === "MultiEdit"
  ) {
    const filePath = stringField(input, "file_path");
    return filePath === null ? [] : [filePath];
  }

  if (payload.tool_name === "NotebookEdit") {
    const notebookPath = stringField(input, "notebook_path");
    return notebookPath === null ? [] : [notebookPath];
  }

  if (payload.tool_name === "Bash") {
    const command = stringField(input, "command");
    if (command === null || !hasWriteIntent(command)) return [];
    return extractBashWriteTargets(command, payload.cwd)
      .filter((p) => p.includes(".clobber/offices/"));
  }

  return [];
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
