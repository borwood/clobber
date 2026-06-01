import type { Database } from "bun:sqlite";
import type { Role, TriggerOverrides } from "@clobber/shared";
import { deleteForkBranch, isProtectedRoleBranch } from "./role-repo.ts";
import { resolveRoleRepoDir, type RoleRepoResolution } from "./resolve-role-repo-dir.ts";
import type { RoleStore } from "./role-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

// #413 — remove a forked role and its residue: the role row (whose FKs cascade
// role_versions / workspace_role_ceilings / agents / sessions / trigger_dispatches),
// its git fork-branch, and the one config ref with no FK — the workspace's
// trigger_overrides entry (a JSON map keyed by role_id). The sibling of
// fork-role.ts: fork mints these, delete reaps them.

export interface DeleteRoleDeps extends RoleRepoResolution {
  readonly roles: Pick<RoleStore, "delete">;
  readonly sessions: Pick<SessionStore, "countActive">;
  readonly workspaces: Pick<WorkspaceStore, "get" | "updateConfig">;
}

export interface DeleteRoleGuards {
  readonly persistent: boolean;
  readonly liveSessions: number;
  readonly ceiling: number;
  readonly spawnedAgents: number;
}

// `hard` guards are refused even with --force (the role is embodied right now —
// reap the session first); `force` guards are deliberate-but-recoverable and
// --force overrides them.
export type GuardClass = "hard" | "force";

export interface GuardViolation {
  readonly guard: "live_sessions" | "persistent" | "spawned_agents";
  readonly class: GuardClass;
  readonly detail: string;
}

export function gatherDeleteGuards(
  db: Database,
  deps: DeleteRoleDeps,
  role: Role,
  workspaceId: string,
): DeleteRoleGuards {
  const liveSessions = deps.sessions.countActive(workspaceId, role.id);
  const ceilingRow = db
    .prepare(
      "SELECT max_concurrent FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?",
    )
    .get(workspaceId, role.id) as { max_concurrent: number } | null;
  const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
  const spawnedAgents = (
    db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND role_id = ?")
      .get(workspaceId, role.id) as { n: number }
  ).n;
  return { persistent: role.persistent, liveSessions, ceiling, spawnedAgents };
}

// The hazard guarded is continuity-blindness — deleting a role out from under
// the agents living it. A live session is the sharp edge: its row is FK-cascaded
// away with the role, so it is a HARD stop. Persistence and spawned-agents are
// softer signals of "this role is in use" and yield to an explicit --force.
export function evaluateDeleteGuards(g: DeleteRoleGuards): GuardViolation[] {
  const violations: GuardViolation[] = [];
  if (g.liveSessions > 0) {
    violations.push({
      guard: "live_sessions",
      class: "hard",
      detail: `${g.liveSessions} live session(s) — reap them before deleting`,
    });
  }
  if (g.persistent) {
    violations.push({
      guard: "persistent",
      class: "force",
      detail: "role is persistent (a workspace's permanent inhabitant)",
    });
  }
  if (g.ceiling > 0 && g.spawnedAgents > 0) {
    violations.push({
      guard: "spawned_agents",
      class: "force",
      detail: `${g.spawnedAgents} spawned agent(s) under a non-zero ceiling (${g.ceiling})`,
    });
  }
  return violations;
}

export function blockingViolations(
  violations: readonly GuardViolation[],
  force: boolean,
): GuardViolation[] {
  return force ? violations.filter((v) => v.class === "hard") : [...violations];
}

export interface DeleteRoleResult {
  readonly role_id: string;
  readonly name: string;
  readonly deleted_branch: string | null;
}

export function deleteRole(
  db: Database,
  deps: DeleteRoleDeps,
  role: Role,
  workspaceId: string,
): DeleteRoleResult {
  // Only a role's OWN fork branch is residue to clean. A role still pinned to a
  // shared `<name>-default` upstream ref (seeded, never edited) has none — its
  // row goes, the default branch stays re-seedable.
  let deletedBranch: string | null = null;
  if (role.current_commit !== undefined && !isProtectedRoleBranch(role.current_commit.branch)) {
    const repoDir = resolveRoleRepoDir(role, deps);
    if (repoDir === undefined) {
      throw new Error(`no role repo resolves for role ${role.name}`);
    }
    deleteForkBranch(repoDir, role.current_commit.branch);
    deletedBranch = role.current_commit.branch;
  }

  const workspace = deps.workspaces.get(workspaceId);
  if (workspace === null) throw new Error(`workspace not found: ${workspaceId}`);
  if (role.id in workspace.trigger_overrides) {
    const scrubbed: TriggerOverrides = {};
    for (const [k, v] of Object.entries(workspace.trigger_overrides)) {
      if (k !== role.id) scrubbed[k] = v;
    }
    deps.workspaces.updateConfig(workspaceId, { trigger_overrides: scrubbed });
  }

  const removed = deps.roles.delete(role.id);
  if (!removed) throw new Error(`role row vanished mid-delete: ${role.id}`);

  return { role_id: role.id, name: role.name, deleted_branch: deletedBranch };
}
