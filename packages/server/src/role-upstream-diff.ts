import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "@clobber/shared";
import type { ForkRef } from "./role-repo.ts";
import { git, gitDiffNoIndex, readTreeAtCommit, writeTreeToDir } from "./role-git.ts";
import { UPSTREAM_REMOTE } from "./workspace-role-repos.ts";
import type { RoleTree } from "./role-tree.ts";

// #401 step-1 — upstream read verbs for the roles-as-VCS workflow. The workspace
// clone carries an `upstream` remote pointing at the engine repo; these helpers
// compare the local role pin against its resolved upstream default.

// Compute `git merge-base ref1 ref2`; returns null if either ref is unreachable.
function computeMergeBase(repoDir: string, ref1: string, ref2: string): string | null {
  const res = Bun.spawnSync(
    ["git", "-C", repoDir, "merge-base", ref1, ref2],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (res.exitCode !== 0) return null;
  return res.stdout.toString().trim();
}

// Resolve which upstream default ref this role should be compared against.
// Engine-derived roles (with a shipped `<name>-default` fork) return
// `upstream/<name>-default` directly. Workspace-invented roles use
// `git merge-base` to find the upstream default with the DEEPEST common
// ancestor with the role's sha — the git-native provenance accessor (#342).
// Deeper merge-base = more specific fork lineage (e.g. upstream/manager-default
// gives OLD_SHA while upstream/worker-default only gives the root base commit).
// Throws with a clean message if no engine ancestor is found; never a silent
// wrong-target diff.
export function resolveUpstreamRef(
  repoDir: string,
  role: Role,
  roleForks: ReadonlyMap<string, ForkRef>,
): string {
  const commit = role.current_commit;
  if (commit === undefined) {
    throw new Error(`role ${role.name} has no commit pin`);
  }

  // Engine-derived: role name matches a shipped default → upstream/<name>-default.
  if (roleForks.has(role.name)) {
    return `${UPSTREAM_REMOTE}/${role.name}-default`;
  }

  // Workspace-invented: find the upstream default with the deepest common
  // ancestor. `git merge-base A B` returns the most recent common ancestor of A
  // and B; the upstream fork whose merge-base with the role is deepest (i.e. its
  // merge-base is an ancestor of all other merge-bases) is the fork this role
  // descends from. Works even when the upstream has advanced past the fork point.
  let bestRef: string | undefined;
  let bestMergeBase: string | undefined;

  for (const [, fork] of roleForks) {
    const upstreamRef = `${UPSTREAM_REMOTE}/${fork.branch}`;
    const mb = computeMergeBase(repoDir, commit.sha, upstreamRef);
    if (mb === null) continue;

    if (bestMergeBase === undefined) {
      bestRef = upstreamRef;
      bestMergeBase = mb;
    } else if (mb !== bestMergeBase) {
      // Is `mb` more recent (deeper) than `bestMergeBase`? If bestMergeBase is
      // an ancestor of mb, then mb is deeper.
      const res = Bun.spawnSync(
        ["git", "-C", repoDir, "merge-base", "--is-ancestor", bestMergeBase, mb],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (res.exitCode === 0) {
        bestRef = upstreamRef;
        bestMergeBase = mb;
      }
    }
  }

  if (bestRef === undefined || bestMergeBase === undefined) {
    throw new Error(
      `role ${role.name} has no engine default to diff against` +
        ` (workspace-invented role with no upstream ancestor — clean-report, not a diff)`,
    );
  }

  // Guard: if the deepest merge-base equals the role's own sha, something is
  // degenerate (the role IS the merge-base). Surface as clean error.
  if (bestMergeBase === commit.sha) {
    throw new Error(
      `role ${role.name} has no engine default to diff against` +
        ` (role sha equals merge-base — not a valid fork lineage)`,
    );
  }

  return bestRef;
}

// Materialize two trees to temp dirs and compute a unified diff between them.
// Sibling to computeDiffContent (which is (checkout-dir vs baseline-tree));
// diffTrees is tree-vs-tree: both sides are commits, neither is a live checkout.
// Normalizes embedded temp-dir paths to a/<file> / b/<file>. Cleans up both
// temp dirs regardless of outcome.
export function diffTrees(treeA: RoleTree, treeB: RoleTree): string {
  const tmpA = mkdtempSync(join(tmpdir(), "clobber-upstream-diff-a-"));
  const tmpB = mkdtempSync(join(tmpdir(), "clobber-upstream-diff-b-"));
  try {
    writeTreeToDir(tmpA, treeA);
    writeTreeToDir(tmpB, treeB);
    const raw = gitDiffNoIndex(tmpA, tmpB);
    const a = tmpA.endsWith("/") ? tmpA : `${tmpA}/`;
    const b = tmpB.endsWith("/") ? tmpB : `${tmpB}/`;
    return raw.replaceAll(a, "a/").replaceAll(b, "b/");
  } finally {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  }
}

// Fetch upstream remote in the workspace role repo. Refreshes upstream/*-default
// remote-tracking refs so diff/log see the current engine state.
export function fetchUpstream(repoDir: string): void {
  git(repoDir, "fetch", UPSTREAM_REMOTE);
}

// Diff the role's local pin sha vs its resolved upstream default. Returns the
// unified diff content (empty string = no differences).
export function diffRoleVsUpstream(
  repoDir: string,
  role: Role,
  roleForks: ReadonlyMap<string, ForkRef>,
): string {
  const upstreamRef = resolveUpstreamRef(repoDir, role, roleForks);
  const localTree = readTreeAtCommit(repoDir, role.current_commit!.sha);
  const upstreamTree = readTreeAtCommit(repoDir, upstreamRef);
  return diffTrees(localTree, upstreamTree);
}

// List commits on the upstream default NOT yet in the local pin (what changed
// upstream). `<local-sha>..<upstream-ref>` = commits reachable from upstream
// that are not reachable from the local sha. Returns --oneline log output.
export function logUpstreamAhead(
  repoDir: string,
  role: Role,
  roleForks: ReadonlyMap<string, ForkRef>,
): string {
  const upstreamRef = resolveUpstreamRef(repoDir, role, roleForks);
  return git(repoDir, "log", "--oneline", `${role.current_commit!.sha}..${upstreamRef}`);
}
