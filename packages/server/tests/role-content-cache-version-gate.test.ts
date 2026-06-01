import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createRoleContentCache } from "../src/role-content-cache.ts";
import { ensureUpstreamRoleRepo } from "../src/role-repo.ts";

// #429 — version-gate the role-content cache. A row cached before a contract
// field existed re-hydrates with that field `undefined` (unvalidated JSON.parse
// cast). The gate: contract_version < ENGINE_CONTRACT_VERSION => miss => reload
// fresh via loadRoleContractAtCommit => re-cache at current version.
//
// This test reproduces the CACHE-HIT-OF-STALE-JSON path — NOT the fresh
// deserialize path that #428 mistakenly covered. It would fail against the
// un-gated cache (stale row is served, field is undefined) and passes with
// the gate (stale row is bypassed, field resolves to its normalized value).

describe("role-content cache version gate (#429)", () => {
  let roleRepoDir: string;

  beforeEach(() => {
    roleRepoDir = mkdtempSync(join(tmpdir(), "clobber-cache-gate-repo-"));
  });
  afterEach(() => {
    rmSync(roleRepoDir, { recursive: true, force: true });
  });

  it("stale-version row is not served — getOrLoad reloads fresh and re-caches", () => {
    const repoHandle = ensureUpstreamRoleRepo(roleRepoDir);
    const fork = repoHandle.forks.get("worker")!;
    const sha = fork.sha;

    const db = createDatabase(":memory:");
    const cache = createRoleContentCache(db);

    // Seed a stale row: contract_json omits the `habits` field (simulating any
    // field added after this row was cached), contract_version is one behind.
    const staleVersion = ENGINE_CONTRACT_VERSION - 1;
    const staleJson = JSON.stringify({
      framing: "",
      systemPrompt: "",
      skills: [],
      allowedTools: [],
      allowedCliCommands: [],
      hooks: "{}",
      triggers: [],
      seedRefs: [],
      wakePrograms: [],
      defaultWakeProgram: null,
      // `habits` intentionally omitted — the field that shipped after this row
    });
    db.prepare(
      "INSERT INTO materialized_role_cache (sha, contract_json, contract_version, created_at) VALUES (?, ?, ?, ?)",
    ).run(sha, staleJson, staleVersion, Date.now());

    // Verify the stale row IS present (so any hit would come from it).
    const rawRow = db
      .prepare("SELECT contract_json, contract_version FROM materialized_role_cache WHERE sha = ?")
      .get(sha) as { contract_json: string; contract_version: number };
    expect(rawRow).not.toBeNull();
    const staleParsed = JSON.parse(rawRow.contract_json) as { habits?: unknown };
    // Without the fix: get() would return this row, and contract.habits is undefined.
    expect(staleParsed.habits).toBeUndefined();

    // WITH the fix: getOrLoad detects stale version, reloads fresh, and returns a
    // normalized contract. `habits` resolves to an array (never undefined).
    const result = cache.getOrLoad(sha, roleRepoDir);
    expect(Array.isArray(result.contract.habits)).toBe(true);
    expect(result.contractVersion).toBe(ENGINE_CONTRACT_VERSION);

    // The re-cached row must now carry the current contract_version so a second
    // getOrLoad is a valid hit, not another miss.
    const updatedRow = db
      .prepare("SELECT contract_version FROM materialized_role_cache WHERE sha = ?")
      .get(sha) as { contract_version: number };
    expect(updatedRow.contract_version).toBe(ENGINE_CONTRACT_VERSION);

    db.close();
  });

  it("get() treats a stale-version row as a miss (returns null)", () => {
    const repoHandle = ensureUpstreamRoleRepo(roleRepoDir);
    const fork = repoHandle.forks.get("worker")!;
    const sha = fork.sha;

    const db = createDatabase(":memory:");
    const cache = createRoleContentCache(db);

    db.prepare(
      "INSERT INTO materialized_role_cache (sha, contract_json, contract_version, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      sha,
      JSON.stringify({ framing: "", systemPrompt: "", skills: [], allowedTools: [], allowedCliCommands: [], hooks: "{}", triggers: [], seedRefs: [], wakePrograms: [], defaultWakeProgram: null }),
      ENGINE_CONTRACT_VERSION - 1,
      Date.now(),
    );

    // Stale row is in the DB, but get() must return null — same as a cold miss.
    expect(cache.get(sha)).toBeNull();

    db.close();
  });

  it("current-version row is served from cache without reloading", () => {
    const repoHandle = ensureUpstreamRoleRepo(roleRepoDir);
    const fork = repoHandle.forks.get("worker")!;
    const sha = fork.sha;

    const db = createDatabase(":memory:");
    const cache = createRoleContentCache(db);

    // Warm the cache with a valid load.
    const first = cache.getOrLoad(sha, roleRepoDir);
    expect(first.contractVersion).toBe(ENGINE_CONTRACT_VERSION);

    // A second call must return the cached value — the row is at current version.
    const second = cache.get(sha);
    expect(second).not.toBeNull();
    expect(second!.contractVersion).toBe(ENGINE_CONTRACT_VERSION);
    expect(second!.contract.habits).toBeDefined();

    db.close();
  });
});
