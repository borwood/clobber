import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRoleManifest,
  ROLE_FILE,
  ROLE_NAME_RE,
  type Role,
  type RoleEditManifest,
  type Session,
} from "@clobber/shared";
import { commitResolves } from "./role-pin-audit.ts";
import { deserializeRoleTree } from "./role-tree.ts";
import {
  ensureEditBranch,
  materializeCheckout,
  readCheckout,
} from "./role-checkout-repo.ts";
import { revParse, type CommitProvenance } from "./role-git.ts";
import { finalizeRoleCommit } from "./role-commit.ts";
import { resolveRoleByIdOrName } from "./resolve-role.ts";
import {
  baselineTree,
  checkoutDirOf,
  clearCheckout,
  computeChanges,
  computeDiffContent,
  deskFor,
  ensureCommitPinned,
  readSidecar,
  renderRoleMd,
  repoDirOf,
  requireConfig,
  writeSidecar,
  type RoleCheckoutDeps,
  type RouteResult,
} from "./role-checkout-context.ts";

// #216 — the working-copy verbs: checkout / status / diff / commit / discard. A
// role is a git branch; these let an agent edit it like code. The server owns
// all git + DB writes; the desk holds plain files the agent edits with normal
// tools. `commit` advances the branch + pin with NO new role_versions row — the
// no-demotion guarantee that closes #396.

// #411 — surface a degraded checkout as a reasoned 4xx, logging the underlying
// cause server-side so the failure is not a black box. The residual states this
// guards (after #412 made `--apply` produce resolvable pins) all share one
// remedy: an operator repins via `role-cutover --apply`. We never auto-repair.
function degrade(status: number, message: string, cause: unknown): RouteResult {
  if (cause instanceof Error) console.error(`[role-checkout] ${message}`, cause.stack);
  else console.error(`[role-checkout] ${message}`);
  return { status, body: { error: message } };
}

export function openCheckout(
  deps: RoleCheckoutDeps,
  session: Session,
  idOrName: string,
): RouteResult {
  const cfg = requireConfig(deps);
  const found = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
  if (found === null || found.workspace_id !== session.workspace_id) {
    return { status: 404, body: { error: `role not found: ${idOrName}` } };
  }
  if (!ROLE_NAME_RE.test(found.name)) {
    return { status: 400, body: { error: `role name is not a git-safe slug: ${found.name}` } };
  }

  // Lazy per-role cutover: a still-row-backed role is committed onto a <name>
  // branch on first edit, so the flow works whether or not the global cutover
  // (#395) has run. A role with no pin and no version to migrate from can't be
  // repaired here — surface it as a reasoned 422, not a bare 500.
  let role: Role;
  try {
    role = ensureCommitPinned(deps, cfg, found, session.workspace_id);
  } catch (err) {
    return degrade(
      422,
      `role ${found.name} has no resolvable commit pin: ${(err as Error).message}; run \`clobber roles role-cutover --apply\` to repin`,
      err,
    );
  }

  // Explicit guard replacing the `!`: ensureCommitPinned's contract guarantees a
  // pin, so reaching here is a reasoned 422 — never a TypeError on `commit.sha`.
  const commit = role.current_commit;
  if (commit === undefined) {
    return degrade(422, `role ${role.name} resolved without a commit pin`, undefined);
  }

  const deskDir = deskFor(deps, session);
  const open = readSidecar(deskDir);
  if (open !== null && open.role_id !== role.id) {
    return {
      status: 409,
      body: {
        error: `a checkout is already open for a different role (${open.role_id}); discard it first`,
      },
    };
  }

  let repoDir: string;
  try {
    repoDir = repoDirOf(deps, role);
  } catch (err) {
    return degrade(
      422,
      `no fork-repo is available for role ${role.name}; run \`clobber roles role-cutover --apply\` to provision it`,
      err,
    );
  }

  // The #412 disconnect's residual state: the DB pin's sha is absent from the
  // on-disk fork-repo (repo regenerated, or pin minted elsewhere). The git ops
  // below would bare-500 on it; classify it first with the audit's resolve check.
  if (!commitResolves(repoDir, commit.sha)) {
    return degrade(
      409,
      `role ${role.name} is pinned to ${commit.sha} but that commit does not resolve in its fork-repo (${repoDir}); run \`clobber roles role-cutover --apply\` to repin`,
      undefined,
    );
  }

  // The working copy is edited on a LOCAL `<name>` branch (the design's editable
  // line, distinct from the shared `<name>-default` upstream ancestor). A seeded
  // role pinned to `<name>-default` gets its local `<name>` branch established
  // here at the pinned sha; `commit` advances it and repins the role to it.
  const branch = role.name;
  ensureEditBranch(repoDir, branch, commit.sha);

  const dir = checkoutDirOf(deskDir);
  materializeCheckout(repoDir, commit.sha, dir);
  writeFileSync(join(dir, ROLE_FILE), renderRoleMd(role));
  writeSidecar(deskDir, { role_id: role.id, branch, base_sha: commit.sha });

  return {
    status: 200,
    body: { role_id: role.id, branch, base_sha: commit.sha, checkout_dir: dir },
  };
}

export function checkoutStatus(deps: RoleCheckoutDeps, session: Session): RouteResult {
  requireConfig(deps);
  const deskDir = deskFor(deps, session);
  const sidecar = readSidecar(deskDir);
  if (sidecar === null) return { status: 200, body: { open: false } };
  const role = deps.roles.get(sidecar.role_id);
  if (role === null) return { status: 200, body: { open: false } };

  const repoDir = repoDirOf(deps, role);
  const tip = revParse(repoDir, sidecar.branch);
  const changed = computeChanges(checkoutDirOf(deskDir), baselineTree(role, repoDir, sidecar.branch));
  return {
    status: 200,
    body: {
      open: true,
      role_id: role.id,
      role_name: role.name,
      branch: sidecar.branch,
      base_sha: sidecar.base_sha,
      stale: tip !== sidecar.base_sha,
      changed,
    },
  };
}

export function diffCheckout(deps: RoleCheckoutDeps, session: Session): RouteResult {
  requireConfig(deps);
  const deskDir = deskFor(deps, session);
  const sidecar = readSidecar(deskDir);
  if (sidecar === null) return { status: 400, body: { error: "no checkout is open" } };
  const role = deps.roles.get(sidecar.role_id);
  if (role === null) return { status: 404, body: { error: "checkout references a missing role" } };

  const repoDir = repoDirOf(deps, role);
  const tip = revParse(repoDir, sidecar.branch);
  const baseline = baselineTree(role, repoDir, sidecar.branch);
  const checkoutDir = checkoutDirOf(deskDir);
  const changed = computeChanges(checkoutDir, baseline);
  const diff = computeDiffContent(checkoutDir, baseline);
  return { status: 200, body: { changed, diff, stale: tip !== sidecar.base_sha } };
}

export interface CommitOptions {
  readonly message: string;
  readonly force?: boolean | undefined;
}

export function commitCheckout(
  deps: RoleCheckoutDeps,
  session: Session,
  opts: CommitOptions,
): RouteResult {
  const cfg = requireConfig(deps);
  const deskDir = deskFor(deps, session);
  const sidecar = readSidecar(deskDir);
  if (sidecar === null) return { status: 400, body: { error: "no checkout is open" } };
  const role = deps.roles.get(sidecar.role_id);
  if (role === null || role.workspace_id !== session.workspace_id) {
    return { status: 404, body: { error: "checkout references a missing role" } };
  }

  const repoDir = repoDirOf(deps, role);
  const tip = revParse(repoDir, sidecar.branch);
  if (tip !== sidecar.base_sha && opts.force !== true) {
    return {
      status: 409,
      body: {
        error: `branch ${sidecar.branch} advanced since checkout (base ${sidecar.base_sha.slice(0, 8)} → tip ${tip.slice(0, 8)}); re-checkout or commit with --force`,
      },
    };
  }

  const tree = new Map(readCheckout(checkoutDirOf(deskDir)));
  const roleMd = tree.get(ROLE_FILE);
  if (roleMd === undefined) return { status: 400, body: { error: `checkout is missing ${ROLE_FILE}` } };
  let manifest: RoleEditManifest;
  try {
    manifest = parseRoleManifest(roleMd);
  } catch (err) {
    return { status: 400, body: { error: `${ROLE_FILE}: ${(err as Error).message}` } };
  }
  if (manifest.name !== role.name) {
    return {
      status: 400,
      body: {
        error: `renaming a role via ${ROLE_FILE} is not supported (v1): ${role.name} → ${manifest.name}`,
      },
    };
  }
  tree.delete(ROLE_FILE);

  let contract;
  try {
    contract = deserializeRoleTree(tree);
  } catch (err) {
    return { status: 400, body: { error: `invalid role tree: ${(err as Error).message}` } };
  }

  if (session.label === undefined) {
    return {
      status: 422,
      body: { error: "session has no label; cannot stamp agent identity on commit" },
    };
  }
  const provenance: CommitProvenance = {
    label: session.label,
    role: role.name,
    pin: session.role_commit!.sha,
    sessionId: session.id,
  };

  const result = finalizeRoleCommit(deps, cfg, {
    role,
    repoDir,
    branch: sidecar.branch,
    baseSha: sidecar.base_sha,
    contract,
    manifest,
    message: opts.message,
    provenance,
  });

  if (result.status === 200) clearCheckout(deskDir);
  return result;
}

export function discardCheckout(deps: RoleCheckoutDeps, session: Session): RouteResult {
  requireConfig(deps);
  const deskDir = deskFor(deps, session);
  const sidecar = readSidecar(deskDir);
  if (sidecar === null) return { status: 200, body: { discarded: false } };
  clearCheckout(deskDir);
  return { status: 200, body: { discarded: true, role_id: sidecar.role_id } };
}
