import { existsSync } from "node:fs";
import { join } from "node:path";
import { slugify, type Agent, type SpawnWorktree, type Workspace } from "@clobber/shared";
import type { SpawnMode } from "./spawn-context.ts";

// Resolves the working directory a session is spawned into. With the
// workspace's spawn_worktree policy off this is the shared checkout (today's
// behavior). With it on, the worktree is agent-scoped:
//   - First attach (no stored identity yet): derive branch+path, create the
//     worktree via git, persist the identity on the agent row via setIdentity.
//   - Every later attach/resume: read the stored identity and return it
//     directly without calling deriveWorktree. If the path is no longer on
//     disk (strand victim — e.g. off→on flip after #631), recreate it;
//     git arbitrates: its loud failure is the no-silent-reuse guarantee (#217).
//
// Cleanup of these worktrees is out of scope (#198); this only ever creates.
export const INSTALL_TIMEOUT_MS = 120_000;

// Thrown by createWorktree/installDeps and caught at the spawn-pipeline layer
// to produce a structured HTTP error instead of a bare Fastify 500 (#656).
export class WorktreeError extends Error {
  constructor(
    readonly kind: "collision" | "fetch-failed" | "install-failed",
    readonly branch: string,
    readonly path: string,
    readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export async function resolveSpawnCwd(
  workspace: Workspace,
  agent: Agent,
  mode: SpawnMode,
  setIdentity: (branch: string, path: string) => void,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
): Promise<string> {
  if (workspace.spawn_worktree.kind === "off") return workspace.repo_path;

  if (agent.worktree_branch !== undefined && agent.worktree_path !== undefined) {
    // Stored identity: reuse. If the path is gone (strand victim), recreate it.
    // Do NOT existsSync-skip git — let git worktree add arbitrate, surfacing
    // failures loudly to preserve the #217 collision guarantee.
    if (!existsSync(agent.worktree_path)) {
      // Recreate path: rollback on failure but MUST NOT clear the identity row
      // (a later attach re-recreates from the still-valid stored identity).
      await createWorktree(workspace.repo_path, agent.worktree_branch, agent.worktree_path, installTimeoutMs);
    }
    return agent.worktree_path;
  }

  // No stored identity yet. Derive + create on any attach (covers first-attach
  // and off→on flip strand victims where the agent already has sessions).
  const { branch, worktreePath } = deriveWorktree(workspace.repo_path, agent, workspace.spawn_worktree);
  if (mode === "attach") {
    await createWorktree(workspace.repo_path, branch, worktreePath, installTimeoutMs);
    // setIdentity is outside createWorktree's own catch, so wrap it here:
    // a failing identity-persist strands the durable worktree+branch (#660).
    try {
      setIdentity(branch, worktreePath);
    } catch (err) {
      rollbackWorktree(workspace.repo_path, branch, worktreePath);
      throw err;
    }
  }
  return worktreePath;
}

// Pure path math: the worktree root a session with `label` would use for
// `policy`. When policy is off (or label is undefined), returns `repoPath`.
// Exported for the habit-receiver sentinel expansion — no I/O.
//
// Default root is .clobber/worktrees/ inside the repo (gitignored). A custom
// root stored in policy.worktree_root places worktrees elsewhere.
export function worktreeRootFor(
  repoPath: string,
  label: string | undefined,
  policy: SpawnWorktree,
): string {
  if (policy.kind === "off" || label === undefined) return repoPath;
  const slug = slugify(label);
  if (slug === "") return repoPath;
  const root =
    policy.kind === "on" && policy.worktree_root !== undefined && policy.worktree_root !== ""
      ? policy.worktree_root
      : join(repoPath, ".clobber", "worktrees");
  return join(root, slug);
}

// Branch and path are derived deterministically from the agent label (the
// manager labels workers by issue #), so a resume lands in the same worktree.
// Determinism is also what makes the collision guarantee meaningful: two
// spawns sharing a label resolve to the same branch/path, and git refuses the
// second — no silent reuse.
//
// Branch name = "<prefix>/<slug>" when policy carries a branch_prefix, or
// bare "<slug>" (default). Root path delegates to worktreeRootFor (T1: single
// source — worktreeRootFor is also exported for the habit-receiver sentinel).
function deriveWorktree(
  repoPath: string,
  agent: Agent,
  policy: SpawnWorktree,
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
  const prefix = policy.kind === "on" ? policy.branch_prefix : undefined;
  const branch = prefix !== undefined && prefix !== "" ? `${prefix}/${slug}` : slug;
  const worktreePath = worktreeRootFor(repoPath, agent.label, policy);
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
//
// TRANSACTIONAL: a successful `git worktree add` followed by a failing install
// is rolled back (worktree remove --force + branch -D) so a same-label retry
// starts clean (#658). Rollback failures are surfaced in the thrown error.
async function createWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string,
  installTimeoutMs: number,
): Promise<void> {
  const originRef = resolveOriginDefault(repoPath);
  if (originRef !== undefined) {
    const fetchRes = Bun.spawnSync(
      ["git", "-C", repoPath, "fetch", "origin"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (fetchRes.exitCode !== 0) {
      throw new WorktreeError(
        "fetch-failed",
        branch,
        worktreePath,
        fetchRes.stderr.toString().trim(),
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
    throw new WorktreeError(
      "collision",
      branch,
      worktreePath,
      res.stderr.toString().trim(),
      `git worktree add failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
  // Worktree is now durable. Any failure from here must be rolled back so a
  // retry with the same label starts clean (no stranded branch/worktree).
  try {
    await installDeps(worktreePath, installTimeoutMs);
  } catch (err) {
    const installMsg = err instanceof Error ? err.message : String(err);
    const rollbackErrors = rollbackWorktree(repoPath, branch, worktreePath);
    const suffix = rollbackErrors.length > 0 ? `; rollback errors: ${rollbackErrors.join(", ")}` : "";
    throw new WorktreeError("install-failed", branch, worktreePath, installMsg,
      `bun install failed in worktree ${worktreePath}${suffix}`);
  }
}

// Removes a durable worktree and deletes its branch. Returns any git error
// strings (rollback itself failing is rare but possible; the caller surfaces
// them in the thrown error it was already building).
function rollbackWorktree(repoPath: string, branch: string, worktreePath: string): string[] {
  const removeRes = Bun.spawnSync(
    ["git", "-C", repoPath, "worktree", "remove", "--force", worktreePath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const branchRes = Bun.spawnSync(
    ["git", "-C", repoPath, "branch", "-D", branch],
    { stdout: "pipe", stderr: "pipe" },
  );
  const errors: string[] = [];
  if (removeRes.exitCode !== 0) errors.push(`worktree remove: ${removeRes.stderr.toString().trim()}`);
  if (branchRes.exitCode !== 0) errors.push(`branch -D: ${branchRes.stderr.toString().trim()}`);
  return errors;
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
//
// Uses async Bun.spawn (not spawnSync) so the event loop services other
// requests during install — preventing cross-workspace DoS (#657).
// A timeout kills a wedged install so the spawn fails fast (#658 AC2).
async function installDeps(worktreePath: string, installTimeoutMs: number): Promise<void> {
  if (!existsSync(join(worktreePath, "package.json"))) return;
  const proc = Bun.spawn(["bun", "install"], {
    cwd: worktreePath,
    stdout: "ignore",
    stderr: "pipe",
  });

  // Promise.race so the timeout rejects immediately even if proc.exited is
  // delayed by bun blocking in waitpid() for a child lifecycle script.
  // SIGKILL (not SIGTERM) ensures bun install can't ignore/defer the signal.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    proc.exited.finally(() => clearTimeout(killTimer)),
    new Promise<never>((_, reject) => {
      killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`bun install timed out after ${installTimeoutMs}ms in ${worktreePath}`));
      }, installTimeoutMs);
    }),
  ]);

  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `bun install failed in worktree ${worktreePath} (exit ${code}): ${stderr.trim().slice(0, 500)}`,
    );
  }
}
