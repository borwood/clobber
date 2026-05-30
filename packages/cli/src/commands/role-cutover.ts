import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { snapshotDatabase } from "@clobber/server/migration-harness.ts";
import { createDatabase } from "@clobber/server/db.ts";
import { resolveDefaultDatabasePath } from "@clobber/server/db-path.ts";
import {
  runRoleStateCutover,
  roleRepoDirForDb,
  type CutoverInvariants,
} from "@clobber/server/role-state-cutover.ts";
import type { Command, CommandContext } from "../commands.ts";
import { CliUsageError } from "../usage-error.ts";

// `RECOVERY-PROMPT.md` lives in the manager's office; an `--apply` that trips a
// post-state violation points the human there rather than guessing a rollback.
const RECOVERY_PROMPT = "RECOVERY-PROMPT.md (in the manager's office)";

interface ParsedArgs {
  readonly dbPath: string | undefined;
  readonly apply: boolean;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let dbPath: string | undefined;
  let apply = false;
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (tok === "--db") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        throw new CliUsageError("role-cutover: --db requires a path");
      }
      dbPath = value;
      i += 1;
      continue;
    }
    if (tok === "--apply") {
      apply = true;
      continue;
    }
    throw new CliUsageError(`role-cutover: unexpected argument: ${tok}`);
  }
  return { dbPath, apply };
}

function renderInvariants(inv: CutoverInvariants): string {
  const lines = [
    `  role_versions rows: ${inv.versionRowsBefore} -> ${inv.versionRowsAfter} (retained, forward-only)`,
    `  workspace roles migrated, now commit-pinned: ${inv.workspaceRolesPinned}`,
    `  null-workspace roles pinned to <name>-default: ${inv.nullWorkspaceRolesPinned}`,
    `  workspace clones ensured (already commit-pinned): ${inv.clonesEnsured}`,
    `  skipped (no version pointer at all): ${inv.skippedNoVersion}`,
  ];
  for (const flagged of inv.flaggedNoDefault) {
    lines.push(`  ! ${flagged.name} (${flagged.id}): null-workspace role with no shipped default — left untouched for inspection`);
  }
  return lines.join("\n");
}

function gate(inv: CutoverInvariants): string {
  return inv.violations.length === 0
    ? "ALL INVARIANTS HELD"
    : `INVARIANTS VIOLATED:\n${inv.violations.map((v) => `  - ${v}`).join("\n")}`;
}

// Rehearse the cutover against an isolated copy + throwaway role-repo dir. The
// live db is opened read-only (VACUUM INTO) and the production role-repo dirs
// beside it are never touched.
function runDryRun(ctx: CommandContext, livePath: string): number {
  const tmp = mkdtempSync(join(tmpdir(), "clobber-cutover-"));
  try {
    const copyPath = join(tmp, "clobber-copy.db");
    snapshotDatabase(livePath, copyPath);
    const roleRepoDir = join(tmp, "clobber-role-repo");
    const db = createDatabase(copyPath);
    let outcome;
    try {
      outcome = runRoleStateCutover(db, roleRepoDir);
    } finally {
      db.close();
    }
    const held = outcome.invariants.violations.length === 0;
    ctx.stdout.write(
      `Dry-run cutover against a copy of ${livePath}\n` +
        `(the live file was opened read-only and never modified)\n\n` +
        `${renderInvariants(outcome.invariants)}\n\n${gate(outcome.invariants)}\n`,
    );
    return held ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Mutate the real db. Back it up FIRST, run, then VERIFY the post-state; on any
// violation point at the recovery prompt. The role-repo dirs are the production
// ones (beside the db), so this is the irreversible human-gated step.
function runApply(ctx: CommandContext, livePath: string): number {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = join(dirname(livePath), `clobber.db.backup-${stamp}`);
  snapshotDatabase(livePath, backupPath);
  ctx.stdout.write(`Backed up live db to ${backupPath}\n`);

  const roleRepoDir = roleRepoDirForDb(livePath);
  const db = createDatabase(livePath);
  let outcome;
  try {
    outcome = runRoleStateCutover(db, roleRepoDir);
  } finally {
    db.close();
  }

  ctx.stdout.write(
    `\nApplied cutover to ${livePath}\n\n${renderInvariants(outcome.invariants)}\n\n${gate(outcome.invariants)}\n`,
  );
  if (outcome.invariants.violations.length > 0) {
    ctx.stderr.write(
      `\nPost-state verification FAILED. The pre-cutover db is at ${backupPath}.\n` +
        `Recovery instructions: ${RECOVERY_PROMPT}.\n`,
    );
    return 1;
  }
  return 0;
}

async function run(ctx: CommandContext): Promise<number> {
  const { dbPath, apply } = parseArgs(ctx.args);
  const livePath =
    dbPath === undefined ? resolveDefaultDatabasePath(process.env, process.cwd()) : dbPath;
  if (!existsSync(livePath)) {
    throw new CliUsageError(
      `role-cutover: live database not found at ${livePath} (pass --db <path> to override)`,
    );
  }
  return apply ? runApply(ctx, livePath) : runDryRun(ctx, livePath);
}

export const roleCutoverCommand: Command = {
  name: "role-cutover",
  local: true,
  summary:
    "Run (or rehearse) the forward-only role-state git migration with the server's own wiring.",
  usage: [
    "usage: clobber role-cutover [--db <path>] [--apply]",
    "",
    "Runs the #393 forward-only migration that commit-pins every role into its",
    "per-workspace fork repo, using the SAME wiring the server boots.",
    "",
    "Default (dry-run): snapshots the live clobber.db to a temp copy and a",
    "throwaway role-repo dir, runs the migration against the copy, and asserts the",
    "forward-only invariants (role_versions retained; every row-backed role ends",
    "commit-pinned). The live db and production role-repos are never written.",
    "",
    "  --apply   Run against the real db (backs it up first, then verifies the",
    "            post-state). The irreversible, human-gated cutover.",
    "  --db <path>   Database to operate on (default: <repo-root>/clobber.db,",
    "                or $CLOBBER_DB if set).",
  ].join("\n"),
  run,
};
