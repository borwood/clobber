import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRoleManifest, ROLE_FILE, type RoleEditManifest, type Role, type Session } from "@clobber/shared";
import { roleEditSpecBody } from "@clobber/runtime";
import { type RoleTree } from "./role-tree.ts";
import { readCheckout } from "./role-checkout-repo.ts";
import { gitDiffNoIndex, readTreeAtCommit, writeTreeToDir } from "./role-git.ts";
import { migrateWorkspaceRole } from "./role-state-git-migration.ts";
import { resolveRoleRepoDir } from "./resolve-role-repo-dir.ts";
import { deskDirFor } from "./desk-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { RoleContentCache } from "./role-content-cache.ts";
import type { ForkRef } from "./role-repo.ts";
import type { WorkspaceRoleRepos } from "./workspace-role-repos.ts";
import type { TriggerScheduler } from "./trigger-scheduler.ts";

// #216 — shared context for the working-copy verbs (role-checkout.ts): the deps
// bundle, the desk/sidecar path math, the ROLE.md projection from the row, and
// the tree-vs-tip change computation. The verbs compose these; keeping them here
// keeps each surface single-responsibility under the file-size ceiling.

export interface RoleCheckoutDeps {
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly workspaces: WorkspaceStore;
  readonly scheduler: Pick<TriggerScheduler, "reloadRole">;
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
  readonly roleForks?: ReadonlyMap<string, ForkRef>;
  readonly workspaceRepos?: WorkspaceRoleRepos;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export interface Sidecar {
  readonly role_id: string;
  readonly branch: string;
  readonly base_sha: string;
}

export interface RequiredConfig {
  readonly roleRepoDir: string;
  readonly roleContentCache: RoleContentCache;
  readonly workspaceRepos: WorkspaceRoleRepos;
  readonly roleForks: ReadonlyMap<string, ForkRef>;
}

// The working-copy verbs require git-as-truth (a role repo). Its absence is a
// misconfiguration, not a fallback case — surface it rather than degrade.
export function requireConfig(deps: RoleCheckoutDeps): RequiredConfig {
  const { roleRepoDir, roleContentCache, workspaceRepos, roleForks } = deps;
  if (
    roleRepoDir === undefined ||
    roleContentCache === undefined ||
    workspaceRepos === undefined ||
    roleForks === undefined
  ) {
    throw new Error("working-copy verbs require git-as-truth (a role repo) to be configured");
  }
  return { roleRepoDir, roleContentCache, workspaceRepos, roleForks };
}

const CHECKOUT_SUBDIR = "role-checkout";
const SIDECAR_FILE = ".clobber-checkout.json";

export function deskFor(deps: RoleCheckoutDeps, session: Session): string {
  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) throw new Error(`workspace not found: ${session.workspace_id}`);
  if (session.agent_id === undefined) {
    throw new Error("a role checkout requires an agent desk; this session has no agent");
  }
  return deskDirFor(workspace.repo_path, session.agent_id);
}

export const checkoutDirOf = (deskDir: string): string => join(deskDir, CHECKOUT_SUBDIR);
const sidecarPathOf = (deskDir: string): string => join(deskDir, SIDECAR_FILE);

export function readSidecar(deskDir: string): Sidecar | null {
  const path = sidecarPathOf(deskDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Sidecar;
}

export function writeSidecar(deskDir: string, sidecar: Sidecar): void {
  mkdirSync(deskDir, { recursive: true });
  writeFileSync(sidecarPathOf(deskDir), `${JSON.stringify(sidecar, null, 2)}\n`);
}

export function clearCheckout(deskDir: string): void {
  rmSync(checkoutDirOf(deskDir), { recursive: true, force: true });
  rmSync(sidecarPathOf(deskDir), { force: true });
}

// The role's canonical metadata, projected for the ROLE.md frontmatter. Description
// is genuinely required (non-optional in the schema); a role lacking it can't render
// a frontmatter and must surface the error. Effort is optional — absent on migrated
// roles predating the field — and is spread conditionally like model.
export function manifestFromRole(role: Role): RoleEditManifest {
  if (role.description === undefined) {
    throw new Error(`role ${role.name} has no description; set one before editing it`);
  }
  return {
    name: role.name,
    description: role.description,
    persistent: role.persistent,
    // Optional: absent on roles predating the effort field; omitted from the
    // frontmatter so an effort-less ROLE.md round-trips unchanged.
    ...(role.effort === undefined ? {} : { effort: role.effort }),
    // Optional: a role with no model default renders no `model:` frontmatter line.
    ...(role.model === undefined ? {} : { model: role.model }),
  };
}

export function renderRoleMd(role: Role): string {
  return renderRoleManifest(manifestFromRole(role), roleEditSpecBody(role.name));
}

export function repoDirOf(deps: RoleCheckoutDeps, role: Role): string {
  const dir = resolveRoleRepoDir(role, deps);
  if (dir === undefined) throw new Error(`no role repo resolves for role ${role.name}`);
  return dir;
}

// Lazy per-role cutover: a still-row-backed role is committed onto a `<name>`
// branch on first edit, so the working-copy flow (checkout AND checkout -b)
// works whether or not the global cutover (#395) has run. A role already
// commit-pinned is returned unchanged. Shared by openCheckout (edit the role)
// and forkRole (branch a new role off it) so the cutover lives in one place.
export function ensureCommitPinned(
  _deps: RoleCheckoutDeps,
  _cfg: RequiredConfig,
  role: Role,
  _workspaceId: string,
): Role {
  if (role.current_commit !== undefined) return role;
  throw new Error(`role ${role.name} has no pin`);
}

export interface FileChange {
  readonly path: string;
  readonly status: "added" | "removed" | "modified";
}

// The checkout's tree vs the branch tip's, with ROLE.md compared against the
// frontmatter the checkout would regenerate from the row — so a metadata edit
// reads as a ROLE.md change, not as a spurious add.
export function computeChanges(checkoutDir: string, baseline: RoleTree): FileChange[] {
  const current = readCheckout(checkoutDir);
  const paths = new Set<string>([...baseline.keys(), ...current.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = baseline.get(path);
    const after = current.get(path);
    if (before === undefined) changes.push({ path, status: "added" });
    else if (after === undefined) changes.push({ path, status: "removed" });
    else if (before !== after) changes.push({ path, status: "modified" });
  }
  return changes;
}

export function baselineTree(role: Role, repoDir: string, branch: string): RoleTree {
  const tree = new Map(readTreeAtCommit(repoDir, branch));
  tree.set(ROLE_FILE, renderRoleMd(role));
  return tree;
}

// Compute a unified diff of the checkout against the branch-tip baseline. The
// baseline is materialized to a temp dir so git diff --no-index can compare it
// with the checkout dir; the temp dir is removed regardless of outcome. Paths
// in the output are normalized to `a/<file>` / `b/<file>` so the caller gets a
// clean readable diff without embedded temp-dir paths.
export function computeDiffContent(checkoutDir: string, baseline: RoleTree): string {
  const tmp = mkdtempSync(join(tmpdir(), "clobber-role-diff-"));
  try {
    writeTreeToDir(tmp, baseline);
    const raw = gitDiffNoIndex(tmp, checkoutDir);
    const a = tmp.endsWith("/") ? tmp : `${tmp}/`;
    const b = checkoutDir.endsWith("/") ? checkoutDir : `${checkoutDir}/`;
    return raw.replaceAll(a, "a/").replaceAll(b, "b/");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
