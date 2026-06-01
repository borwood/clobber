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
import { auditRolePins, type RolePinAudit } from "@clobber/server/role-pin-audit.ts";
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

function renderAudit(audit: RolePinAudit): string {
  return [
    `  roles checked: ${audit.checked}`,
    `  commit-pinned: ${audit.pinned}/${audit.checked}`,
    `  pins that resolve on disk: ${audit.resolved}/${audit.checked}`,
  ].join("\n");
}

function gate(violations: readonly string[]): string {
  return violations.length === 0
    ? "ALL INVARIANTS HELD"
    : `INVARIANTS VIOLATED:\n${violations.map((v) => `  - ${v}`).join("\n")}`;
}

// The dry-run is a LIVE pin↔repo audit, not a migration rehearsal: it asserts
// that every live role row is commit-pinned AND its sha resolves in its on-disk
// fork-repo. The live db is opened read-only (VACUUM INTO a copy) and the
// production role-repo dirs beside it are read, never written or created — so a
// missing repo or a stale pin surfaces as a violation instead of being papered
// over by re-migrating a throwaway clone (#412).
function runDryRun(ctx: CommandContext, livePath: string): number {
  const tmp = mkdtempSync(join(tmpdir(), "clobber-cutover-"));
  try {
    const copyPath = join(tmp, "clobber-copy.db");
    snapshotDatabase(livePath, copyPath);
    const db = createDatabase(copyPath);
    let audit;
    try {
      audit = auditRolePins(db, roleRepoDirForDb(livePath));
    } finally {
      db.close();
    }
    const held = audit.violations.length === 0;
    ctx.stdout.write(
      `Pin↔repo audit against a copy of ${livePath}\n` +
        `(the live file was opened read-only and never modified; on-disk` +
        ` fork-repos were read, never written)\n\n` +
        `${renderAudit(audit)}\n\n${gate(audit.violations)}\n`,
    );
    return held ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Mutate the real db. Back it up FIRST, run, then VERIFY the post-state against
// the production fork-repos; on any violation point at the recovery prompt. The
// migration's forward-only invariants and the pin↔repo resolve audit are both
// gated, so an apply that pins a row to a sha its repo cannot resolve FAILS
// rather than reporting a hollow success.
function runApply(ctx: CommandContext, livePath: string): number {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = join(dirname(livePath), `clobber.db.backup-${stamp}`);
  snapshotDatabase(livePath, backupPath);
  ctx.stdout.write(`Backed up live db to ${backupPath}\n`);

  const roleRepoDir = roleRepoDirForDb(livePath);
  const db = createDatabase(livePath);
  let outcome;
  let audit;
  try {
    outcome = runRoleStateCutover(db, roleRepoDir);
    audit = auditRolePins(db, roleRepoDir);
  } finally {
    db.close();
  }

  const violations = [...outcome.invariants.violations, ...audit.violations];
  ctx.stdout.write(
    `\nApplied cutover to ${livePath}\n\n` +
      `${renderInvariants(outcome.invariants)}\n${renderAudit(audit)}\n\n` +
      `${gate(violations)}\n`,
  );
  if (violations.length > 0) {
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
    "Default (dry-run): a LIVE pin↔repo audit. Reads the live rows (via a",
    "read-only copy) and the production fork-repos on disk, and FAILS unless every",
    "role row is commit-pinned AND its sha resolves in its fork-repo. The live db",
    "and the role-repos are read, never written. A null pin or a stale sha (the",
    "pin↔repo disconnect behind the checkout-500) reports a violation.",
    "",
    "  --apply   Run the migration against the real db (backs it up first), then",
    "            verify BOTH the forward-only invariants and the pin↔repo audit.",
    "            The irreversible, human-gated cutover.",
    "  --db <path>   Database to operate on (default: <repo-root>/clobber.db,",
    "                or $CLOBBER_DB if set).",
  ].join("\n"),
  run,
};
