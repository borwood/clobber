import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGIN_HOOKS_REL,
  baseRole,
  enumerateShippedRoles,
  loadRoleBundle,
  managerRole,
  workerRole,
} from "@clobber/runtime";
import { snapshotShippedBundle } from "../src/role-version-snapshot.ts";
import type { LoadedRole } from "@clobber/runtime";

// Mirror the seed path: a shipped role is embodied with its effective
// (composed) allowed-tools. This is the canonical "shipped bundle → role
// version" projection that seedWorkspaceRoles drives.
function snapshotEffective(loaded: LoadedRole) {
  return snapshotShippedBundle({ loaded, allowedTools: loaded.allowedTools });
}

// The load-bearing #355 invariant: the effective embodied role (base ⊕ fork)
// must EQUAL today's self-contained manager/worker — no behaviour regression.
// `golden` was captured from the pre-extraction bundles; if a future base edit
// leaks into an effective role, or a fork drifts, these equalities break.
const golden = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "effective-roles.golden.json"), "utf8"),
) as {
  readonly manager: ReturnType<typeof snapshotShippedBundle>;
  readonly worker: ReturnType<typeof snapshotShippedBundle>;
};

describe("base ⊕ fork composition (#355)", () => {
  it("compose(base, manager-overlay) equals today's manager — no regression", () => {
    expect(snapshotEffective(loadRoleBundle("manager")!)).toEqual(golden.manager);
  });

  it("compose(base, worker-overlay) equals today's worker — no regression", () => {
    expect(snapshotEffective(loadRoleBundle("worker")!)).toEqual(golden.worker);
  });

  it("base is abstract — never embodied, only forked from", () => {
    // base is not a spawnable shipped role: it never appears in the registry.
    const names = enumerateShippedRoles().map((r) => r.manifest.name);
    expect(names).not.toContain("base");
    expect(loadRoleBundle("base")).toBeNull();
  });

  it("base owns the universal layer (baseline tools + hooks mechanism)", () => {
    expect([...baseRole.allowedTools]).toEqual([
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
    ]);
    expect(baseRole.permissionMode).toBe("bypassPermissions");
    expect(baseRole.hooksJson).toContain("__CLOBBER_HOOK_URL__");
  });

  it("forks inherit the universal layer instead of re-specifying it", () => {
    // A future base update must merge in cleanly — so the forks must NOT
    // re-declare base content. They omit the universal scalars...
    expect(managerRole.manifest.allowedTools).toBeUndefined();
    expect(managerRole.manifest.permissionMode).toBeUndefined();
    expect(workerRole.manifest.allowedTools).toBeUndefined();
    expect(workerRole.manifest.permissionMode).toBeUndefined();

    // ...and the effective role resolves them from base.
    expect([...managerRole.allowedTools]).toEqual([...baseRole.allowedTools]);
    expect(managerRole.permissionMode).toBe(baseRole.permissionMode);
    expect([...workerRole.allowedTools]).toEqual([...baseRole.allowedTools]);
    expect(workerRole.permissionMode).toBe(baseRole.permissionMode);
  });

  it("the hooks mechanism lives once in base — forks no longer ship a copy", () => {
    for (const fork of [managerRole, workerRole]) {
      const forkHooks = join(fork.bundleRoot, fork.manifest.pluginTemplatePath, PLUGIN_HOOKS_REL);
      expect(existsSync(forkHooks)).toBe(false);
      expect(fork.hooksJson).toBe(baseRole.hooksJson);
    }
  });

  it("compose merges skills by name — fork content survives intact", () => {
    // base ships no skills today, so the effective skill set is exactly the
    // fork's. The merge path is still exercised: a fork skill overrides/extends
    // base by name, ready for future shared base skills.
    const managerSkills = managerRole.skills.map((s) => s.name);
    expect(managerSkills).toContain("assignment");
    expect(managerSkills).toContain("wisdom-capture");
    const workerSkills = workerRole.skills.map((s) => s.name);
    expect(workerSkills).toContain("research");
    expect(workerSkills).toContain("watch-ci");
  });
});
