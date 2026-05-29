import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { buildAndRegress } from "@clobber/server/migration-harness.ts";
import { createRoleStore } from "@clobber/server/role-store.ts";
import { run } from "../src/main.ts";

function collect(stream: PassThrough): { text: () => string } {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("clobber db-dryrun", () => {
  it("rehearses pending migrations on a copy without agent env and never writes the live db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-dryrun-cli-"));
    const dbPath = join(dir, "live.db");
    try {
      // A populated database in a pre-#236 shape on disk.
      buildAndRegress({
        path: dbPath,
        seed: (db) => {
          createRoleStore(db).create({ name: "manager", persistent: true });
        },
        regress: (db) => {
          db.exec("ALTER TABLE role_versions DROP COLUMN contract_version");
        },
      });
      const liveBefore = readFileSync(dbPath);

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const out = collect(stdout);

      // No CLOBBER_API_BASE / CLOBBER_SESSION_TOKEN: a local dev command must
      // run without the agent env the lazy resolver only demands on server use.
      const code = await run({
        argv: ["db-dryrun", "--db", dbPath],
        env: {},
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      const text = out.text();
      expect(text).toContain("never modified");
      expect(text).toContain("role_versions.contract_version");

      // HARD CONSTRAINT: the live file is byte-identical after the dry-run.
      const liveAfter = readFileSync(dbPath);
      expect(Buffer.compare(liveBefore, liveAfter)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors clearly when the live database does not exist", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const err = collect(stderr);
    const code = await run({
      argv: ["db-dryrun", "--db", "/nonexistent/clobber.db"],
      env: {},
      stdout,
      stderr,
    });
    expect(code).toBe(2);
    expect(err.text()).toContain("live database not found");
  });
});
