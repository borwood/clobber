import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createDatabase } from "@clobber/server/db.ts";
import { createWorkspaceStore } from "@clobber/server/workspace-store.ts";
import { createRoleStore } from "@clobber/server/role-store.ts";
import { seedWorkspaceRoles } from "@clobber/server/seed-workspace-roles.ts";
import { run } from "../src/main.ts";

function collect(stream: PassThrough): { text: () => string } {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

// Build a live db on disk carrying a workspace whose roles are row-backed (no
// forks passed → seeded onto `current_version_id`, the pre-#349 shape the
// cutover migrates). Closed before returning so the file is the only handle.
function buildLiveDb(dbPath: string): void {
  const db = createDatabase(dbPath);
  const ws = createWorkspaceStore(db).create({ name: "w", repo_path: "/tmp/x" });
  seedWorkspaceRoles(db, ws.id); // no forks → row-backed
  const role = createRoleStore(db).findInWorkspace(ws.id, "manager")!;
  expect(role.current_version_id).toBeDefined();
  expect(role.current_commit).toBeUndefined();
  db.close();
}

describe("clobber role-cutover", () => {
  it("dry-run (default) reproduces the forward-only invariants on a copy and never writes the live db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-cutover-cli-"));
    const dbPath = join(dir, "clobber.db");
    try {
      buildLiveDb(dbPath);
      const liveBefore = readFileSync(dbPath);

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const out = collect(stdout);

      // No CLOBBER_API_BASE / SESSION_TOKEN: a local dev command must run
      // without the agent env. No --apply: dry-run is the DEFAULT.
      const code = await run({
        argv: ["role-cutover", "--db", dbPath],
        env: {},
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      const text = out.text();
      // It rehearsed against a copy, read-only on the source.
      expect(text).toContain("never modified");
      // role_versions row count is reported and unchanged (forward-only).
      expect(text).toContain("role_versions");
      // The row-backed workspace roles were migrated to commit pins.
      expect(text).toMatch(/workspace roles? .*commit-pinned/i);
      // The invariant gate passed.
      expect(text).toContain("INVARIANTS HELD");

      // HARD CONSTRAINT: the live file is byte-identical after the dry-run, and
      // production role-repo dirs were never created beside it.
      const liveAfter = readFileSync(dbPath);
      expect(Buffer.compare(liveBefore, liveAfter)).toBe(0);
      expect(existsSync(join(dir, "clobber-role-repo"))).toBe(false);
      expect(existsSync(join(dir, "role-repos"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors clearly when the live database does not exist", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const err = collect(stderr);
    const code = await run({
      argv: ["role-cutover", "--db", "/nonexistent/clobber.db"],
      env: {},
      stdout,
      stderr,
    });
    expect(code).toBe(2);
    expect(err.text()).toContain("live database not found");
  });
});
