import { relative, resolve, sep } from "node:path";
import type { PreToolUsePayload } from "@clobber/shared";
import type { RoleStore } from "./role-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

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
    return extractOfficePathCandidates(command);
  }

  return [];
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveToolPath(path: string, cwd: string): string {
  return path.startsWith("/") ? resolve(path) : resolve(cwd, path);
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" ||
    (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep));
}

function hasWriteIntent(command: string): boolean {
  return /(^|[\s;&|])(?:>|>>)/.test(command) ||
    /(^|[\s;&|])\S+>{1,2}/.test(command) ||
    /(^|[\s;&|])(?:tee|cp|mv|install|touch|mkdir|rm|rsync)\b/.test(command);
}

function extractOfficePathCandidates(command: string): string[] {
  const candidates = new Set<string>();
  for (const token of shellishTokens(command)) {
    const path = trimRedirection(token);
    if (path.includes(".clobber/offices/")) {
      candidates.add(path);
    }
  }
  return [...candidates];
}

function trimRedirection(token: string): string {
  return token.replace(/^\d?>{1,2}/, "");
}

function shellishTokens(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined && token.length > 0) out.push(token);
  }
  return out;
}
