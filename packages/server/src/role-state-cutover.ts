import { dirname, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Role } from "@clobber/shared";
import { createRoleStore } from "./role-store.ts";
import { createRoleVersionStore } from "./role-version-store.ts";
import { ensureUpstreamRoleRepo } from "./role-repo.ts";
import { configureRoleEmbodiment } from "./role-embodiment-config.ts";
import {
  migrateRoleStateToWorkspaceRepos,
  type RoleStateMigrationResult,
} from "./role-state-git-migration.ts";

// #393 cutover surface — run the forward-only role-state git migration with the
// SAME wiring the live server boots (`configureRoleEmbodiment` resolves the
// per-workspace clone base; `ensureUpstreamRoleRepo` materializes the upstream),
// then prove the forward-only invariants held. The dry-run command rehearses
// this against a COPY db + a throwaway role-repo dir; `--apply` runs it against
// the real ones. Both paths share this core so the rehearsal exercises exactly
// what the apply will.

// Production derives the upstream role-repo dir from the db's data dir
// (`index.ts`): it lives beside `clobber.db`. Resolving it here keeps the CLI
// from hardcoding the layout.
export function roleRepoDirForDb(dbPath: string): string {
  return resolve(dirname(dbPath), "clobber-role-repo");
}

interface RoleFacts {
  readonly id: string;
  readonly name: string;
  readonly inWorkspace: boolean;
  readonly hadVersion: boolean;
  readonly hadCommit: boolean;
}

export interface CutoverInvariants {
  readonly versionRowsBefore: number;
  readonly versionRowsAfter: number;
  readonly workspaceRolesPinned: number;
  readonly nullWorkspaceRolesPinned: number;
  readonly clonesEnsured: number;
  readonly skippedNoVersion: number;
  // Null-workspace row-backed roles with no shipped `<name>-default` fork to
  // anchor to: left untouched ON PURPOSE for inspection, surfaced rather than
  // counted as a silent skip (the migration's documented "no default" branch).
  readonly flaggedNoDefault: readonly { readonly id: string; readonly name: string }[];
  readonly violations: readonly string[];
}

export interface CutoverOutcome {
  readonly result: RoleStateMigrationResult;
  readonly invariants: CutoverInvariants;
}

function factsOf(role: Role): RoleFacts {
  return {
    id: role.id,
    name: role.name,
    inWorkspace: role.workspace_id !== undefined,
    hadVersion: false,
    hadCommit: role.current_commit !== undefined,
  };
}

// Runs the migration against `db` using `roleRepoDir` as the upstream/clone
// root, then derives the forward-only invariants by comparing each role's
// before/after pin. `db` and `roleRepoDir` are caller-chosen: a copy + tmp dir
// for the dry-run, the live db + production dir for the apply.
export function runRoleStateCutover(db: Database, roleRepoDir: string): CutoverOutcome {
  const roles = createRoleStore(db);
  const upstream = ensureUpstreamRoleRepo(roleRepoDir);
  const { workspaceRepos } = configureRoleEmbodiment(db, roleRepoDir);
  if (workspaceRepos === undefined) throw new Error("git-as-truth wiring is not configured");

  const before = roles.list().map((role) => factsOf(role));
  const versionRowsBefore = countVersionRows(db);

  const result = migrateRoleStateToWorkspaceRepos({
    roles,
    roleVersions: createRoleVersionStore(db),
    upstream,
    workspaceRepos,
  });

  const versionRowsAfter = countVersionRows(db);
  const after = new Map(roles.list().map((role) => [role.id, role]));

  const violations: string[] = [];
  const flaggedNoDefault: { id: string; name: string }[] = [];
  let workspaceRolesPinned = 0;
  let nullWorkspaceRolesPinned = 0;

  if (versionRowsAfter !== versionRowsBefore) {
    violations.push(
      `role_versions row count changed ${versionRowsBefore} -> ${versionRowsAfter} (forward-only: rows must be retained)`,
    );
  }

  for (const role of before) {
    const now = after.get(role.id)!;
    const pinned = now.current_commit !== undefined;
    if (!role.hadVersion) {
      // Roles with no version pointer are the only legitimate skips.
      continue;
    }
    if (role.inWorkspace) {
      if (pinned) workspaceRolesPinned += 1;
      else violations.push(`workspace role ${role.name} (${role.id}) was not commit-pinned`);
      continue;
    }
    // Null-workspace (global template) role: pinned to its `<name>-default` fork.
    const hasFork = upstream.forks.has(role.name);
    if (pinned) nullWorkspaceRolesPinned += 1;
    else if (!hasFork) flaggedNoDefault.push({ id: role.id, name: role.name });
    else violations.push(`null-workspace role ${role.name} (${role.id}) has a default but was not pinned`);
  }

  const skippedNoVersion = before.filter((r) => !r.hadVersion && !r.hadCommit).length;
  if (result.skipped !== skippedNoVersion) {
    violations.push(
      `skipped=${result.skipped} but ${skippedNoVersion} roles have no version (skip must mean only that)`,
    );
  }

  return {
    result,
    invariants: {
      versionRowsBefore,
      versionRowsAfter,
      workspaceRolesPinned,
      nullWorkspaceRolesPinned,
      clonesEnsured: result.clonesEnsured,
      skippedNoVersion,
      flaggedNoDefault,
      violations,
    },
  };
}

function countVersionRows(db: Database): number {
  return (db.prepare("SELECT COUNT(*) n FROM role_versions").get() as { n: number }).n;
}
