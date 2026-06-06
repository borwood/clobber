import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "@clobber/shared";
import type { ForkRef } from "./role-repo.ts";
import { BASE_BRANCH } from "./role-repo.ts";
import { git, gitDiffNoIndex, readTreeAtCommit, writeTreeToDir } from "./role-git.ts";
import { UPSTREAM_REMOTE } from "./workspace-role-repos.ts";
import type { RoleTree } from "./role-tree.ts";

// #401 step-1 — upstream read verbs for the roles-as-VCS workflow. The workspace
// clone carries an `upstream` remote pointing at the engine repo; these helpers
// compare the local role pin against its resolved upstream default.

// Compute `git merge-base ref1 ref2`.
// Returns null on exit 1 (no common ancestor — disjoint histories).
// Throws on any other non-zero exit (e.g. exit 128 = invalid or unfetched ref)
// with a message prompting the caller to run `clobber roles fetch`.
function computeMergeBase(repoDir: string, ref1: string, ref2: string): string | null {
  const res = Bun.spawnSync(
    ["git", "-C", repoDir, "merge-base", ref1, ref2],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (res.exitCode === 0) return res.stdout.toString().trim();
  if (res.exitCode === 1) return null;
  throw new Error(
    `upstream ref ${ref2} is not available — run \`clobber roles fetch\` first` +
      (res.stderr.toString().trim() ? `: ${res.stderr.toString().trim()}` : ""),
  );
}

// Resolve which upstream default ref this role should be compared against.
// Engine-derived roles (with a shipped `<name>-default` fork) return
// `upstream/<name>-default` directly. Workspace-invented roles scan
// upstream/base plus every *-default fork for the DEEPEST common ancestor
// with the role's sha — the git-native provenance accessor (#342).
//
// upstream/base is seeded as the initial candidate. If no *-default fork has
// a strictly deeper merge-base, base remains the winner — which is exactly
// right for base-derived / equidistant roles (all *-defaults tie at base;
// base is the correct diff target with no tie-breaking flag needed). When a
// *-default has a deeper merge-base (the role descends from that fork), it
// replaces base as the winner. Throws only when there is genuinely no
// upstream ancestor at all.
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

  // Workspace-invented: seed upstream/base as the initial candidate, then
  // check each *-default fork. The candidate whose merge-base with the role
  // is deepest wins. Ties keep the current best (base wins ties because it
  // is seeded first — equidistant / base-derived roles resolve correctly
  // without a separate tie-breaking flag).
  const baseRef = `${UPSTREAM_REMOTE}/${BASE_BRANCH}`;
  let bestRef: string = baseRef;
  let bestMergeBase: string | null = computeMergeBase(repoDir, commit.sha, baseRef);

  for (const [, fork] of roleForks) {
    const upstreamRef = `${UPSTREAM_REMOTE}/${fork.branch}`;
    const mb = computeMergeBase(repoDir, commit.sha, upstreamRef);
    if (mb === null) continue;

    if (bestMergeBase === null) {
      bestRef = upstreamRef;
      bestMergeBase = mb;
    } else if (mb !== bestMergeBase) {
      // Is `mb` strictly deeper than `bestMergeBase`?
      // `--is-ancestor X Y` exits 0 if X is an ancestor of Y (X ≤ Y in depth).
      const res = Bun.spawnSync(
        ["git", "-C", repoDir, "merge-base", "--is-ancestor", bestMergeBase, mb],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (res.exitCode === 0) {
        bestRef = upstreamRef;
        bestMergeBase = mb;
      }
    }
    // mb === bestMergeBase: tied → keep current best (base wins ties; seeded first).
  }

  if (bestMergeBase === null) {
    throw new Error(
      `role ${role.name} has no engine default to diff against` +
        ` (workspace-invented role with no upstream ancestor)`,
    );
  }

  // No guard for bestMergeBase === commit.sha: that means the role sha IS an
  // ancestor of the resolved upstream (unmodified fork behind upstream). The
  // diff shows upstream-ahead content; the log lists the ahead commits. ✓
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
