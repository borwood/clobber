import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Role } from "@clobber/shared";
import { commitContractOnBranch, loadRoleContractAtCommit } from "./role-repo.ts";
import {
  ensureCommitPinned,
  repoDirOf,
  requireConfig,
  type RoleCheckoutDeps,
} from "./role-checkout-context.ts";

// #216 — fork a role as a NEW git branch (`roles checkout -b`, of which
// `roles fork` is a thin CLI alias). The source's content is branched off its
// commit tip onto a fresh `<new-name>` branch; the new role row is inserted
// commit-pinned via pinCommit — NOT a role_versions row. This replaces the old
// row-minting fork: the demotion-on-fork code is gone, and the new role embodies
// from git like every other commit-pinned role.

export interface ForkRoleResult {
  readonly role_id: string;
  readonly branch: string;
  readonly sha: string;
}

export function forkRole(
  db: Database,
  deps: RoleCheckoutDeps,
  source: Role,
  newName: string,
  workspaceId: string,
): ForkRoleResult {
  const cfg = requireConfig(deps);
  const pinnedSource = ensureCommitPinned(deps, cfg, source, workspaceId);
  const commit = pinnedSource.current_commit!;
  const repoDir = repoDirOf(deps, pinnedSource);

  // Branch the source's content off its tip, giving the fork its own commit (and
  // a merge-base ancestor with the source for a future #265 upstream merge).
  const contract = loadRoleContractAtCommit(repoDir, commit.sha);
  const newRef = commitContractOnBranch(
    repoDir,
    newName,
    commit.sha,
    contract,
    `fork ${newName} from ${pinnedSource.name}`,
  );

  const id = randomUUID();
  const createdAt = Date.now();
  const description = source.description === undefined ? null : source.description;
  const permissionMode = source.permission_mode === undefined ? null : source.permission_mode;
  const effort = source.effort === undefined ? null : source.effort;
  const model = source.model === undefined ? null : source.model;
  db.prepare(
    `INSERT INTO roles (id, name, description, permission_mode, effort, model, persistent, workspace_id, current_version_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    newName,
    description,
    permissionMode,
    effort,
    model,
    source.persistent ? 1 : 0,
    workspaceId,
    createdAt,
  );
  deps.roles.pinCommit(id, newRef);
  cfg.roleContentCache.getOrLoad(newRef.sha, repoDir);

  const sourceCeilingRow = db
    .prepare(
      "SELECT max_concurrent FROM workspace_role_ceilings WHERE workspace_id = ? AND role_id = ?",
    )
    .get(workspaceId, source.id) as { max_concurrent: number } | null;
  const inheritedCeiling = sourceCeilingRow === null ? 1 : sourceCeilingRow.max_concurrent;
  db.prepare(
    `INSERT INTO workspace_role_ceilings (workspace_id, role_id, max_concurrent)
     VALUES (?, ?, ?)
     ON CONFLICT (workspace_id, role_id) DO UPDATE SET max_concurrent = excluded.max_concurrent`,
  ).run(workspaceId, id, inheritedCeiling);

  return { role_id: id, branch: newRef.branch, sha: newRef.sha };
}
