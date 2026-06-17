import { z } from "zod";

// Per-workspace policy for isolating each spawned worker in its own git
// worktree. Same tagged-union shape as final-report-callback / boot-context-
// provider: a default-off variant plus the opt-in variants, so new isolation
// strategies plug in additively (add a branch to the union + an arm to the
// resolver).
//
// "off" preserves today's behavior — every session shares the workspace
// checkout. "on" gives each spawn its own worktree (branch + path derived from
// the agent label), the isolation that makes parallel worker dispatch safe.
//
// Engine default is off (Golden Rule 3 — the engine ships zero opinion; a
// workspace opts in). Worktree *cleanup* is out of scope here (#198).
export const SpawnWorktreeOffSchema = z.object({
  kind: z.literal("off"),
});

export const SpawnWorktreeOnSchema = z.object({
  kind: z.literal("on"),
  // Workspace-configured branch prefix. Empty/absent = bare <slug> (default).
  // Example: "clobber" → branch "clobber/<slug>"; "team" → "team/<slug>".
  branch_prefix: z
    .string()
    .meta({ title: "Branch prefix", description: "e.g. \"clobber\" → branch clobber/<slug>. Blank = bare <slug>." })
    .optional(),
  // Workspace-configured root directory under which per-agent worktree dirs
  // land. Absent = .clobber/worktrees/ inside the repo (default).
  // Example: "/mnt/fast-ssd/worktrees" → worktree at "<root>/<slug>".
  worktree_root: z
    .string()
    .meta({ title: "Worktree root", description: "Directory under which per-agent worktrees land. Blank = .clobber/worktrees/." })
    .optional(),
  // Per-workspace bun install timeout in milliseconds. Absent = INSTALL_TIMEOUT_MS
  // default (generous for large monorepos). Useful to tighten in CI or when
  // the repo installs fast and a shorter deadline surfaces real hangs sooner.
  install_timeout_ms: z
    .number()
    .int()
    .positive()
    .meta({ title: "Install timeout (ms)", description: "bun install deadline per spawn. Blank = engine default." })
    .optional(),
});

export const SpawnWorktreeSchema = z
  .discriminatedUnion("kind", [SpawnWorktreeOffSchema, SpawnWorktreeOnSchema])
  .meta({
    title: "Spawn worktree isolation",
    description: "Give each spawned worker its own git worktree (on) or share the workspace checkout (off).",
  });
export type SpawnWorktree = z.infer<typeof SpawnWorktreeSchema>;

export const DEFAULT_SPAWN_WORKTREE: SpawnWorktree = {
  kind: "off",
};
