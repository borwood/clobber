import type { Database } from "bun:sqlite";
import { ENGINE_CONTRACT_VERSION } from "@clobber/shared";
import { loadRoleContractAtCommit } from "./role-repo.ts";
import type { RoleTreeContract } from "./role-tree.ts";

// #349 git-as-truth — the materialized content cache. Embodiment reads a role's
// content from the tree at a commit; that read is git on the hot path, so the
// deserialized contract is memoized by commit sha. A sha addresses an immutable
// tree, so the mapping never changes — a hit is always valid, and a populate on
// miss is the only write. `contract_version` is stamped from the engine that
// materialized the sha (the gate reads it for the contract-compat decision).

export interface CachedRoleContract {
  readonly contract: RoleTreeContract;
  readonly contractVersion: number;
}

export interface RoleContentCache {
  get(sha: string): CachedRoleContract | null;
  // Hit the cache, or read the tree at `sha` from `repoDir`, store it, and return.
  getOrLoad(sha: string, repoDir: string): CachedRoleContract;
}

interface Row {
  contract_json: string;
  contract_version: number;
}

export function createRoleContentCache(db: Database): RoleContentCache {
  const getStmt = db.prepare(
    "SELECT contract_json, contract_version FROM materialized_role_cache WHERE sha = ?",
  );
  const putStmt = db.prepare(
    "INSERT OR REPLACE INTO materialized_role_cache (sha, contract_json, contract_version, created_at) VALUES (?, ?, ?, ?)",
  );

  function get(sha: string): CachedRoleContract | null {
    const row = getStmt.get(sha) as Row | null;
    if (row === null) return null;
    // Stale contract: a row cached before a field existed re-hydrates with that
    // field `undefined` (unvalidated JSON.parse cast). Treat as a miss so the
    // caller reloads fresh via loadRoleContractAtCommit, which normalizes through
    // deserializeRoleTree and stamps the current version.
    if (row.contract_version < ENGINE_CONTRACT_VERSION) return null;
    return {
      contract: JSON.parse(row.contract_json) as RoleTreeContract,
      contractVersion: row.contract_version,
    };
  }

  return {
    get,
    getOrLoad(sha, repoDir) {
      const hit = get(sha);
      if (hit !== null) return hit;
      const contract = loadRoleContractAtCommit(repoDir, sha);
      putStmt.run(sha, JSON.stringify(contract), ENGINE_CONTRACT_VERSION, Date.now());
      return { contract, contractVersion: ENGINE_CONTRACT_VERSION };
    },
  };
}
