import { basename, dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { slugify } from "@clobber/shared";

// Add worktree_branch and worktree_path columns to agents (#635).
// Backfills every labelled agent in a workspace where spawn_worktree is on,
// computing the identity from the same formula resolveSpawnCwd uses at runtime
// (branch = clobber/<slug>, path = <dirname(repo)>/<basename(repo)>-worktrees/<slug>).
// Strand victims (path not on disk) are included — the ensure-exists guard in
// resolveSpawnCwd will create the worktree on the agent's next attach.
// Agents with no label, whitespace-only labels, or in off-policy workspaces
// are left NULL and never derive a worktree.
export function migrateAgentWorktreeIdentity(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (!cols.includes("worktree_branch")) {
    db.exec("ALTER TABLE agents ADD COLUMN worktree_branch TEXT");
  }
  if (!cols.includes("worktree_path")) {
    db.exec("ALTER TABLE agents ADD COLUMN worktree_path TEXT");
  }

  // Backfill on-policy labelled agents that lack an identity.
  const rows = db
    .prepare(
      `SELECT a.id, a.label, w.repo_path, w.spawn_worktree
       FROM agents a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.label IS NOT NULL
         AND a.worktree_branch IS NULL`,
    )
    .all() as Array<{
      id: string;
      label: string;
      repo_path: string;
      spawn_worktree: string;
    }>;

  const update = db.prepare(
    "UPDATE agents SET worktree_branch = ?, worktree_path = ? WHERE id = ?",
  );

  for (const row of rows) {
    let policy: { kind: string };
    try {
      policy = JSON.parse(row.spawn_worktree) as { kind: string };
    } catch {
      continue;
    }
    if (policy.kind !== "on") continue;
    const slug = slugify(row.label);
    if (slug === "") continue;
    const branch = `clobber/${slug}`;
    const path = join(dirname(row.repo_path), `${basename(row.repo_path)}-worktrees`, slug);
    update.run(branch, path, row.id);
  }
}
