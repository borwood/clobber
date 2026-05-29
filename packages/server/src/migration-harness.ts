import { Database } from "bun:sqlite";
import { createDatabase } from "./db.ts";

// Test/dev infrastructure for exercising the FULL createDatabase migration
// sequence against existing (non-fresh) databases — the upgrade path that
// every fresh-`:memory:` migration test silently skips, the blind spot that
// hid #339. Two entry points share one discipline: drive the REAL
// `createDatabase` entrypoint, and NEVER write the source file.

export interface TableShape {
  readonly columns: readonly string[];
  readonly rowCount: number;
}

export interface DbShape {
  readonly tables: Readonly<Record<string, TableShape>>;
}

export interface ColumnChange {
  readonly table: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface RowCountDelta {
  readonly table: string;
  readonly before: number;
  readonly after: number;
}

export interface ShapeDiff {
  readonly addedTables: readonly string[];
  readonly removedTables: readonly string[];
  readonly columnChanges: readonly ColumnChange[];
  readonly rowCountDeltas: readonly RowCountDelta[];
}

export interface RegressFixture {
  // Where the on-disk fixture is built. Must be a real file path (not
  // `:memory:`) — the whole point is an existing database that survives a
  // close/reopen cycle through the real entrypoint.
  readonly path: string;
  // Populate rows on the CURRENT schema (use the real stores).
  readonly seed: (db: Database) => void;
  // Surgically downgrade the schema to a prior shape (`ALTER TABLE … DROP
  // COLUMN …`, table rebuilds, etc.) so reopening exercises the upgrade path.
  readonly regress: (db: Database) => void;
}

export interface DryRunInput {
  // The live database to rehearse against. Opened READ-ONLY; never written.
  readonly livePath: string;
  // Destination for the working copy. Caller owns its lifecycle (cleanup).
  readonly copyPath: string;
}

export interface DryRunResult {
  readonly livePath: string;
  readonly copyPath: string;
  readonly before: DbShape;
  readonly after: DbShape;
  readonly diff: ShapeDiff;
}

// Capture a structural snapshot for diffing: every user table with its column
// names and row count. Table names come from sqlite_master and are therefore
// safe to interpolate.
export function captureShape(db: Database): DbShape {
  const tableNames = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  const tables: Record<string, TableShape> = {};
  for (const name of tableNames) {
    const columns = (
      db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    const counted = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as {
      n: number;
    };
    tables[name] = { columns, rowCount: counted.n };
  }
  return { tables };
}

export function diffShapes(before: DbShape, after: DbShape): ShapeDiff {
  const beforeNames = Object.keys(before.tables);
  const afterNames = Object.keys(after.tables);

  const addedTables = afterNames.filter((n) => !(n in before.tables)).sort();
  const removedTables = beforeNames.filter((n) => !(n in after.tables)).sort();

  const columnChanges: ColumnChange[] = [];
  const rowCountDeltas: RowCountDelta[] = [];
  for (const name of afterNames) {
    const post = after.tables[name]!;
    const pre = before.tables[name];
    if (pre === undefined) continue;
    const added = post.columns.filter((c) => !pre.columns.includes(c));
    const removed = pre.columns.filter((c) => !post.columns.includes(c));
    if (added.length > 0 || removed.length > 0) {
      columnChanges.push({ table: name, added, removed });
    }
    if (pre.rowCount !== post.rowCount) {
      rowCountDeltas.push({
        table: name,
        before: pre.rowCount,
        after: post.rowCount,
      });
    }
  }
  return { addedTables, removedTables, columnChanges, rowCountDeltas };
}

// Build a populated current-schema database at `fixture.path`, then surgically
// regress it to a prior shape and close it. The caller reopens via the real
// `createDatabase(fixture.path)` to exercise the upgrade — kept explicit at the
// call site so the test reads as "reopen through the real entrypoint".
export function buildAndRegress(fixture: RegressFixture): void {
  const db = createDatabase(fixture.path);
  fixture.seed(db);
  fixture.regress(db);
  db.close();
}

// Copy `srcPath` to `destPath` as a consistent snapshot WITHOUT writing the
// source. `VACUUM INTO` from a read-only connection reads through any WAL and
// writes a fresh, fully-checkpointed file — the source bytes never change.
export function snapshotDatabase(srcPath: string, destPath: string): void {
  const source = new Database(srcPath, { readonly: true });
  try {
    source.exec(`VACUUM INTO '${escapeSqlLiteral(destPath)}'`);
  } finally {
    source.close();
  }
}

// Rehearse the pending migrations against a COPY of a live database: snapshot
// it, record the pre-migration shape, run the real `createDatabase` sequence on
// the copy, and diff. The live file is only ever read.
export function dryRunMigration(input: DryRunInput): DryRunResult {
  snapshotDatabase(input.livePath, input.copyPath);
  const before = readShape(input.copyPath);
  const migrated = createDatabase(input.copyPath);
  try {
    const after = captureShape(migrated);
    return {
      livePath: input.livePath,
      copyPath: input.copyPath,
      before,
      after,
      diff: diffShapes(before, after),
    };
  } finally {
    migrated.close();
  }
}

function readShape(path: string): DbShape {
  const db = new Database(path, { readonly: true });
  try {
    return captureShape(db);
  } finally {
    db.close();
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
