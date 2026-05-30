import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// #351 / topology B (#350) — per-workspace role fork-repos. The engine ships ONE
// upstream repo (base + `<name>-default` forks, materialized by role-repo.ts);
// each workspace clones it into its own dir so its forks evolve in isolation and
// adopt upstream changes by consent (`git fetch upstream && git merge`, the #265
// primitive). A clone copies every reachable object, so a role pinned to an
// upstream fork tip resolves byte-identically from the clone; the #351 migration
// then commits each row-backed role's content as a NEW commit living only here.

export interface WorkspaceRoleReposInput {
  // The shared upstream repo (role-repo.ts materialized it). Clones source from it.
  readonly upstreamDir: string;
  // Parent dir the per-workspace clones live under (`<dataDir>/role-repos`).
  readonly reposBaseDir: string;
}

export interface WorkspaceRoleRepos {
  // The workspace's clone dir, cloning + wiring the upstream remote on first use.
  // Idempotent: an existing clone is reused, never re-cloned.
  dirFor(workspaceId: string): string;
}

const UPSTREAM_REMOTE = "upstream";

export function createWorkspaceRoleRepos(input: WorkspaceRoleReposInput): WorkspaceRoleRepos {
  return {
    dirFor(workspaceId: string): string {
      const dir = join(input.reposBaseDir, workspaceId);
      if (existsSync(join(dir, ".git"))) return dir;
      cloneWorkspaceRepo(input.upstreamDir, dir);
      return dir;
    },
  };
}

// `git clone` names the source remote `origin`; rename it to `upstream` so the
// adopt primitive reads as the #265 surface (`git fetch upstream && git merge`).
// The default checkout lands on the upstream's HEAD (`base`); every fork object
// is still copied, so sha-based embodiment resolves without a local branch.
function cloneWorkspaceRepo(upstreamDir: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "clone", "-q", upstreamDir, ".");
  git(dir, "remote", "rename", "origin", UPSTREAM_REMOTE);
}

function git(dir: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
  return res.stdout.toString();
}
