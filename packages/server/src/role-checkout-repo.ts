import { mkdirSync } from "node:fs";
import {
  clearWorkingTree,
  commitTree,
  git,
  readDirInto,
  readTreeAtCommit,
  revParse,
  writeTreeToDir,
} from "./role-git.ts";
import { serializeRoleTree, type RoleTree, type RoleTreeContract } from "./role-tree.ts";
import type { ForkRef } from "./role-repo.ts";

// #216 — the working-copy repo primitives. A role is a git branch; editing it
// like code means: materialize the branch tip into a desk working dir, edit
// files, read them back, and commit them onto the SAME branch (advancing it, not
// forking). These compose the git plumbing in role-git.ts, the same file-walk
// the version store commits with.

// Establish a LOCAL editable branch at `sha`, the role's working-copy line. A
// seeded role is pinned to the shared `<name>-default` fork, which lives in the
// clone only as a remote-tracking ref — committing needs a local branch. This
// (re)points a local `<name>` branch at the pinned sha; HEAD is detached at the
// sha first so the force-update never trips on "the current branch". Idempotent:
// a role already on its local `<name>` branch is reset to the same sha.
export function ensureEditBranch(dir: string, branch: string, sha: string): void {
  git(dir, "checkout", "-q", "--detach", sha);
  git(dir, "branch", "-f", branch, sha);
}

// Advance an EXISTING branch. The sibling of commitContractOnBranch minus the
// `-b`: the working-copy `commit` verb serializes the edited tree back onto the
// role's own branch (it never forks). git content-addresses blobs, so files
// whose bytes match the tip reuse its objects and only the edited file is new.
export function commitOnBranch(
  dir: string,
  branch: string,
  contract: RoleTreeContract,
  message: string,
): ForkRef {
  git(dir, "checkout", "-q", branch);
  commitTree(dir, serializeRoleTree(contract), message);
  return { branch, sha: revParse(dir, branch) };
}

// Materialize a branch tip's tree into a plain working directory (the agent's
// desk checkout), NOT a git repo: the agent edits these files with normal tools,
// then `commit` reads them back. Clears the dest first so the checkout reflects
// the tip exactly, regardless of a prior checkout's leftovers.
export function materializeCheckout(dir: string, ref: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  clearWorkingTree(destDir);
  writeTreeToDir(destDir, readTreeAtCommit(dir, ref));
}

// Read a desk checkout back into a tree. The inverse of materializeCheckout:
// walk the working dir and read every file verbatim, so the `commit` verb can
// deserialize it through the codec (which ignores the ROLE.md sidecar). The
// state sidecar lives OUTSIDE this dir, so there is nothing to skip.
export function readCheckout(destDir: string): RoleTree {
  const tree = new Map<string, string>();
  readDirInto(destDir, "", tree);
  return tree;
}

// The role branches in a repo. A `git branch --list` wrapper distinct from
// `roles list` (DB rows): this exposes the git substrate (and is the first brick
// of v2's git-verb passthrough).
export function listRoleBranches(dir: string): string[] {
  return git(dir, "branch", "--list", "--format=%(refname:short)")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
