import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createDatabase } from "@clobber/server/db.ts";
import { createWorkspaceStore } from "@clobber/server/workspace-store.ts";
import { createRoleStore } from "@clobber/server/role-store.ts";
import { seedWorkspaceRoles } from "@clobber/server/seed-workspace-roles.ts";
import { ensureUpstreamRoleRepo } from "@clobber/server/role-repo.ts";
import { run } from "../src/main.ts";

function collect(stream: PassThrough): { text: () => string } {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

// Build a live db on disk carrying a workspace whose roles are row-backed (no
// forks passed → seeded onto `current_version_id`, the pre-#349 unpinned shape).
// Closed before returning so the file is the only handle.
function buildLiveDb(dbPath: string): void {
  const db = createDatabase(dbPath);
  const ws = createWorkspaceStore(db).create({ name: "w", repo_path: "/tmp/x" });
  seedWorkspaceRoles(db, ws.id); // no forks → row-backed, unpinned
  const role = createRoleStore(db).findInWorkspace(ws.id, "manager")!;
  // After #491: current_version_id is gone; roles seeded without forks have no commit pin.
  expect(role.current_commit).toBeUndefined();
  db.close();
}

async function cutover(
  dbPath: string,
  extra: readonly string[],
): Promise<{ code: number; text: string; errText: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  // No CLOBBER_API_BASE / SESSION_TOKEN: a local dev command runs without the
  // agent env.
  const code = await run({
    argv: ["role-cutover", "--db", dbPath, ...extra],
    env: {},
    stdout,
    stderr,
  });
  return { code, text: out.text(), errText: err.text() };
}

// #412 — the dry-run is a LIVE pin↔repo audit: it reports HELD iff every live
// role row is commit-pinned AND its sha resolves in the on-disk fork-repo. The
// regression that motivated this: the old dry-run rehearsed the migration on a
// COPY and reported "INVARIANTS HELD" while the live rows were null. A detector
// that can't fail on a broken baseline is worse than none — so we disconfirm
// BOTH directions (wisdom 2026-05-30).
describe("clobber role-cutover", () => {
  it("dry-run FAILS when live rows are unpinned (a null pin must report FAIL, not HELD)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-cutover-cli-"));
    const dbPath = join(dir, "clobber.db");
    try {
      buildLiveDb(dbPath);
      const liveBefore = readFileSync(dbPath);

      const { code, text } = await cutover(dbPath, []);

      // The broken baseline must trip the gate.
      expect(code).toBe(1);
      expect(text).toMatch(/VIOLAT/i);
      expect(text).toMatch(/not commit-pinned|null/i);
      // Names the offending roles, not just a count.
      expect(text).toContain("manager");

      // HARD CONSTRAINT: the dry-run reads the live file read-only and never
      // creates production role-repo dirs beside it.
      const liveAfter = readFileSync(dbPath);
      expect(Buffer.compare(liveBefore, liveAfter)).toBe(0);
      expect(existsSync(join(dir, "clobber-role-repo"))).toBe(false);
      expect(existsSync(join(dir, "role-repos"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run reports HELD when roles are already commit-pinned (#491 production case)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-cutover-cli-"));
    const dbPath = join(dir, "clobber.db");
    const roleRepoDir = join(dir, "clobber-role-repo");
    try {
      // Seed with forks (commit-pinned roles) — the production state after #491.
      const db = createDatabase(dbPath);
      const ws = createWorkspaceStore(db).create({ name: "w", repo_path: "/tmp/x" });
      const upstream = ensureUpstreamRoleRepo(roleRepoDir);
      seedWorkspaceRoles(db, ws.id, upstream.forks);
      db.close();

      // --apply on an already-pinned DB is a no-op: all roles pass the audit.
      const applied = await cutover(dbPath, ["--apply"]);
      expect(applied.code, applied.errText).toBe(0);
      expect(applied.text).toContain("INVARIANTS HELD");

      // Subsequent dry-run also holds.
      const { code, text } = await cutover(dbPath, []);
      expect(code, text).toBe(0);
      expect(text).toContain("INVARIANTS HELD");
      expect(text).toMatch(/resolve/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run FAILS when a row's pin sha is missing from the on-disk fork-repo (stale pin)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-cutover-cli-"));
    const dbPath = join(dir, "clobber.db");
    const roleRepoDir = join(dir, "clobber-role-repo");
    try {
      // Seed with commit-pinned roles.
      const dbSeed = createDatabase(dbPath);
      const ws = createWorkspaceStore(dbSeed).create({ name: "w", repo_path: "/tmp/x" });
      const upstream = ensureUpstreamRoleRepo(roleRepoDir);
      seedWorkspaceRoles(dbSeed, ws.id, upstream.forks);
      dbSeed.close();
      const applied = await cutover(dbPath, ["--apply"]);
      expect(applied.code, applied.errText).toBe(0);

      // Repoint manager to a well-formed but absent sha: the DB pin and the
      // on-disk repo are now out of sync — exactly #411's observed 500 case.
      const dbCorrupt = createDatabase(dbPath);
      dbCorrupt.prepare("UPDATE roles SET current_commit_sha = ? WHERE name = 'manager'").run(
        "0".repeat(40),
      );
      dbCorrupt.close();

      const { code, text } = await cutover(dbPath, []);
      expect(code).toBe(1);
      expect(text).toMatch(/VIOLAT/i);
      expect(text).toMatch(/resolve/i);
      expect(text).toContain("manager");
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
