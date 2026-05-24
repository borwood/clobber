import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Agent, Workspace } from "@clobber/shared";
import type { SpawnMode } from "./spawn-context.ts";

// Resolves the working directory a session is spawned into. With the
// workspace's spawn_worktree policy off this is the shared checkout (today's
// behavior). With it on, each fresh spawn (attach) gets its own git worktree —
// the isolation that makes parallel worker dispatch collision-free — and the
// session's cwd is that worktree. Resume reuses the worktree created at attach.
//
// Cleanup of these worktrees is out of scope (#198); this only ever creates.
export function resolveSpawnCwd(
  workspace: Workspace,
  agent: Agent,
  mode: SpawnMode,
): string {
  if (workspace.spawn_worktree.kind === "off") return workspace.repo_path;
  const { branch, worktreePath } = deriveWorktree(workspace.repo_path, agent);
  if (mode === "attach") createWorktree(workspace.repo_path, branch, worktreePath);
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
  const branch = `clobber/${slug}`;
  const worktreePath = join(
    dirname(repoPath),
    `${basename(repoPath)}-worktrees`,
    slug,
  );
  return { branch, worktreePath };
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") {
    throw new Error(`spawn_worktree could not derive a slug from label "${label}"`);
  }
  return slug;
}

// Branches off the repo's current HEAD. git itself throws loudly if the branch
// or the target path already exists — that failure IS the no-silent-reuse
// guarantee, so we surface its stderr rather than pre-checking.
function createWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string,
): void {
  const res = Bun.spawnSync(
    ["git", "-C", repoPath, "worktree", "add", worktreePath, "-b", branch],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (res.exitCode !== 0) {
    throw new Error(
      `git worktree add failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
  installDeps(worktreePath);
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
