import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dryRunMigration,
  type DryRunResult,
  type ShapeDiff,
} from "@clobber/server/migration-harness.ts";
import { resolveDefaultDatabasePath } from "@clobber/server/db-path.ts";
import type { Command, CommandContext } from "../commands.ts";
import { CliUsageError } from "../usage-error.ts";

interface ParsedArgs {
  readonly dbPath: string | undefined;
  readonly keep: boolean;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let dbPath: string | undefined;
  let keep = false;
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (tok === "--db") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        throw new CliUsageError("db-dryrun: --db requires a path");
      }
      dbPath = value;
      i += 1;
      continue;
    }
    if (tok === "--keep") {
      keep = true;
      continue;
    }
    throw new CliUsageError(`db-dryrun: unexpected argument: ${tok}`);
  }
  return { dbPath, keep };
}

function renderDiff(diff: ShapeDiff): string {
  const lines: string[] = [];
  for (const table of diff.addedTables) lines.push(`  + table ${table}`);
  for (const table of diff.removedTables) lines.push(`  - table ${table}`);
  for (const change of diff.columnChanges) {
    for (const col of change.added) lines.push(`  + ${change.table}.${col}`);
    for (const col of change.removed) lines.push(`  - ${change.table}.${col}`);
  }
  for (const delta of diff.rowCountDeltas) {
    lines.push(
      `  ~ ${delta.table}: rows ${delta.before} -> ${delta.after}`,
    );
  }
  return lines.join("\n");
}

function isEmptyDiff(diff: ShapeDiff): boolean {
  return (
    diff.addedTables.length === 0 &&
    diff.removedTables.length === 0 &&
    diff.columnChanges.length === 0 &&
    diff.rowCountDeltas.length === 0
  );
}

function render(result: DryRunResult, keep: boolean): string {
  const header = `Dry-run against a copy of ${result.livePath}\n(the live file was opened read-only and never modified)\n`;
  const body = isEmptyDiff(result.diff)
    ? "No pending schema changes: the copy already matches the current migrations.\n"
    : `Pending migrations would change the schema:\n${renderDiff(result.diff)}\n`;
  const footer = keep
    ? `\nMigrated copy kept at: ${result.copyPath}\n`
    : "";
  return `${header}\n${body}${footer}`;
}

async function run(ctx: CommandContext): Promise<number> {
  const { dbPath, keep } = parseArgs(ctx.args);
  const livePath =
    dbPath === undefined
      ? resolveDefaultDatabasePath(process.env, process.cwd())
      : dbPath;
  if (!existsSync(livePath)) {
    throw new CliUsageError(
      `db-dryrun: live database not found at ${livePath} (pass --db <path> to override)`,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), "clobber-dryrun-"));
  const copyPath = join(tmp, "clobber-copy.db");
  try {
    const result = dryRunMigration({ livePath, copyPath });
    ctx.stdout.write(render(result, keep));
    return 0;
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
}

export const dbDryRunCommand: Command = {
  name: "db-dryrun",
  local: true,
  summary:
    "Rehearse pending DB migrations against a copy of the live clobber.db (never writes the original).",
  usage: [
    "usage: clobber db-dryrun [--db <path>] [--keep]",
    "",
    "Snapshots the live clobber.db to a temporary copy (read-only on the source),",
    "runs the current code's full createDatabase migration sequence against the copy,",
    "and prints the resulting schema diff. The live database is never written.",
    "",
    "  --db <path>   Database to rehearse against (default: <repo-root>/clobber.db,",
    "                or $CLOBBER_DB if set).",
    "  --keep        Keep the migrated copy on disk and print its path instead of",
    "                deleting it (useful for inspecting the post-migration state).",
  ].join("\n"),
  run,
};
