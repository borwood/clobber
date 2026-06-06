import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RoleTree } from "./role-tree.ts";

// #349/#216 — the low-level git + tree-filesystem plumbing shared by the role
// version store (role-repo.ts) and the working-copy verbs (role-checkout-repo.ts).
// Pure mechanics: run git in a dir, materialize a tree to disk, read one back.

export function git(dir: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}

export function revParse(dir: string, ref: string): string {
  return git(dir, "rev-parse", ref).trim();
}

// Replace the working tree with exactly `tree` and commit it. Clearing first
// makes the commit reflect the tree precisely regardless of what the parent
// branch left behind; git content-addresses blobs, so files whose bytes match
// the parent reuse its objects and the merge-base stays shared. `--allow-empty`
// keeps a fork that happens to equal base a legitimate (empty) commit.
export function commitTree(dir: string, tree: RoleTree, message: string): void {
  clearWorkingTree(dir);
  writeTreeToDir(dir, tree);
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.email=clobber@local",
    "-c",
    "user.name=clobber",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    message,
  );
}

// Write a tree's files under `destDir`, creating parent dirs. Shared by the
// in-repo commit path and the desk-checkout materialization.
export function writeTreeToDir(destDir: string, tree: RoleTree): void {
  for (const [rel, content] of tree) {
    const abs = join(destDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

// Walk a directory into a tree of repo-relative path → content. `.git` is never
// part of a role tree, so it is skipped in case the dir happens to be a repo.
export function readDirInto(root: string, prefix: string, tree: Map<string, string>): void {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      readDirInto(root, rel, tree);
    } else {
      tree.set(rel, readFileSync(join(root, rel), "utf8"));
    }
  }
}

export function clearWorkingTree(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

// Run git diff --no-index between two directories. Exit 0 = identical, exit 1 =
// has differences — both are success for a diff query; only other exit codes are
// errors. Returns the raw unified diff string (empty string when no differences).
export function gitDiffNoIndex(baseline: string, working: string): string {
  const res = Bun.spawnSync(
    ["git", "diff", "--no-index", "--", baseline, working],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    throw new Error(
      `git diff --no-index failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}

// Reconstruct a role tree from the commit: list the blobs, then read each one
// verbatim. `git show <ref>:<path>` emits the blob exactly, so empty files and
// trailing newlines round-trip the codec losslessly.
export function readTreeAtCommit(dir: string, ref: string): RoleTree {
  const listing = git(dir, "ls-tree", "-r", "--name-only", ref)
    .split("\n")
    .filter((line) => line.length > 0);
  const tree = new Map<string, string>();
  for (const path of listing) {
    tree.set(path, git(dir, "show", `${ref}:${path}`));
  }
  return tree;
}
