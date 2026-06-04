import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { slugify, type Agent, type Workspace } from "@clobber/shared";
import type { SpawnMode } from "./spawn-context.ts";

// Resolves the working directory a session is spawned into. With the
// workspace's spawn_worktree policy off this is the shared checkout (today's
// behavior). With it on, the worktree is agent-scoped: created on the agent's
// FIRST attach, reused on every attach and resume after. A persistent agent's
// wake is a fresh attach for an existing agent, so keying create on first-attach
// (not on `mode` or `role.persistent`) is what lets it re-wake without git
// refusing a second `worktree add` (#217). first-attach is the invariant;
// persistence is only a proxy for it.
//
// Cleanup of these worktrees is out of scope (#198); this only ever creates.
export function resolveSpawnCwd(
  workspace: Workspace,
  agent: Agent,
  mode: SpawnMode,
  agentHasSession: boolean,
): string {
  if (workspace.spawn_worktree.kind === "off") return workspace.repo_path;
  const { branch, worktreePath } = deriveWorktree(workspace.repo_path, agent);
  const firstAttach = mode === "attach" && !agentHasSession;
  if (firstAttach) createWorktree(workspace.repo_path, branch, worktreePath);
  return worktreePath;
}

// Branch and path are derived deterministically from the agent label (the
// manager labels workers by issue #), so a resume lands in the same worktree.
// Determinism is also what makes the collision guarantee meaningful: two
// spawns sharing a label resolve to the same branch/path, and git refuses the
// second — no silent reuse.
function deriveWorktree(
  repoPath: string,
  agent: Agent,
): { readonly branch: string; readonly worktreePath: string } {
  if (agent.label === undefined) {
    throw new Error(
      "spawn_worktree is on but the agent has no label to derive a worktree branch from",
    );
  }
  const slug = slugify(agent.label);
  if (slug === "") {
    throw new Error(`spawn_worktree could not derive a slug from label "${agent.label}"`);
  }
  const branch = `clobber/${slug}`;
  const worktreePath = join(
    dirname(repoPath),
    `${basename(repoPath)}-worktrees`,
    slug,
  );
  return { branch, worktreePath };
}

// Branches off the remote-tracking default branch (e.g. origin/main) when an
// origin is configured: first fetch so remote-tracking refs are fresh, then use
// the remote ref as the explicit start-point. Falls back to today's behavior
// (branch off current HEAD) when no origin is present — legitimate for
// local-only workspaces.
//
// git itself throws loudly if the branch or target path already exists — that
// failure IS the no-silent-reuse guarantee, so we surface its stderr rather
// than pre-checking.
function createWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string,
): void {
  const originRef = resolveOriginDefault(repoPath);
  if (originRef !== undefined) {
    const fetchRes = Bun.spawnSync(
      ["git", "-C", repoPath, "fetch", "origin"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (fetchRes.exitCode !== 0) {
      throw new Error(
        `git fetch origin failed (exit ${fetchRes.exitCode}): ${fetchRes.stderr.toString().trim()}`,
      );
    }
  }
  const worktreeCmd =
    originRef !== undefined
      ? ["git", "-C", repoPath, "worktree", "add", worktreePath, "-b", branch, originRef]
      : ["git", "-C", repoPath, "worktree", "add", worktreePath, "-b", branch];
  const res = Bun.spawnSync(worktreeCmd, { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(
      `git worktree add failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
  installDeps(worktreePath);
}

// Reads the symbolic ref git sets when a remote is cloned or `git remote
// set-head` is run. Returns the short form (e.g. "origin/main") when present,
// undefined when the repo has no origin — the no-origin config is a legitimate
// local-only workspace, not an error.
function resolveOriginDefault(repoPath: string): string | undefined {
  const res = Bun.spawnSync(
    ["git", "-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (res.exitCode !== 0) return undefined;
  return res.stdout.toString().trim() || undefined;
}

// A fresh worktree shares no files with the shared checkout, so it has no
// node_modules — the worker can't typecheck/test/build until deps install.
// Install them now so `spawn_worktree: on` yields a worktree that's
// immediately workable (#201). A repo with no package.json has nothing to
// install; skipping it keeps non-node worktrees (and bun, which errors with
// no manifest) from breaking the spawn.
function installDeps(worktreePath: string): void {
  if (!existsSync(join(worktreePath, "package.json"))) return;
  const res = Bun.spawnSync(["bun", "install"], {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `bun install failed in worktree ${worktreePath} (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
}
