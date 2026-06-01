import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Role } from "@clobber/shared";
import { createRoleStore } from "./role-store.ts";

// #412 — the pin↔repo consistency audit. The cutover's two failure modes are a
// role row that is not commit-pinned at all, and a row pinned to a sha that does
// not resolve in its on-disk fork-repo (the repo was regenerated, or the pin was
// minted in a different repo). Both make `checkout` 500 (#411). This audit is the
// honest detector: it reads the LIVE rows and the on-disk repos, so a dry-run can
// FAIL on a broken baseline instead of rehearsing a migration on a copy and
// reporting a hollow "held".

export interface RolePinAudit {
  readonly checked: number;
  readonly pinned: number;
  readonly resolved: number;
  readonly violations: readonly string[];
}

// Read-only: does `sha` name a commit object in `dir`? No side effects — never
// clones, never creates the repo. A missing repo or absent object is a finding,
// not an error to repair here.
function commitResolves(dir: string, sha: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;
  const res = Bun.spawnSync(["git", "-C", dir, "cat-file", "-e", `${sha}^{commit}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return res.exitCode === 0;
}

// The on-disk repo a role's pin must resolve in (topology B): a workspace role's
// commit lives only in that workspace's clone; a global (null-workspace) role's
// in the shared upstream. Pure path math — it mirrors resolveRoleRepoDir WITHOUT
// its clone-on-miss side effect, so the audit observes disk rather than creating it.
function repoDirForRole(role: Role, roleRepoDir: string): string {
  if (role.workspace_id === undefined) return roleRepoDir;
  return join(dirname(roleRepoDir), "role-repos", role.workspace_id);
}

// Validate every role row against its on-disk fork-repo. `roleRepoDir` is the
// upstream root (`<dataDir>/clobber-role-repo`); per-workspace clones live beside
// it under `role-repos/<workspace_id>`. Each role must be commit-pinned AND its
// sha must resolve — the post-cutover target shape (#412 acceptance).
export function auditRolePins(db: Database, roleRepoDir: string): RolePinAudit {
  const roles = createRoleStore(db).list();
  const violations: string[] = [];
  let pinned = 0;
  let resolved = 0;
  for (const role of roles) {
    if (role.current_commit === undefined) {
      violations.push(
        `role ${role.name} (${role.id}) is not commit-pinned (git_ref/commit are null)`,
      );
      continue;
    }
    pinned += 1;
    const dir = repoDirForRole(role, roleRepoDir);
    if (!commitResolves(dir, role.current_commit.sha)) {
      violations.push(
        `role ${role.name} (${role.id}) pin ${role.current_commit.sha} does not resolve in its fork-repo (${dir})`,
      );
      continue;
    }
    resolved += 1;
  }
  return { checked: roles.length, pinned, resolved, violations };
}
