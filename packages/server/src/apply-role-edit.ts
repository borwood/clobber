import type { Database } from "bun:sqlite";
import type { Role, RoleTrigger, RoleVersion } from "@clobber/shared";
import type { TriggerScheduler } from "./trigger-scheduler.ts";
import { editRole, type EditRoleResult, type RoleEditPatch } from "./edit-role.ts";

// Triggers are a persistent-role-only capability. Both the agent-scoped
// PATCH /agent/roles/:id and the operator-scoped
// PUT /workspaces/:wid/roles/:rid/triggers must reject the same way and BEFORE
// any mutation, so the guard lives here as a shared predicate rather than being
// inlined (and drifting) in each route.
export function triggersRequirePersistent(
  role: Role,
  triggers: readonly RoleTrigger[] | undefined,
): boolean {
  return triggers !== undefined && triggers.length > 0 && !role.persistent;
}

// The version-bump + scheduler-reload path shared by both trigger-applying
// routes. Callers must enforce triggersRequirePersistent first. Reloading the
// scheduler only when triggers are part of the patch keeps non-trigger edits
// from churning the dispatch table.
export function applyRoleEdit(
  db: Database,
  scheduler: Pick<TriggerScheduler, "reloadRole">,
  role: Role,
  currentVersion: RoleVersion,
  patch: RoleEditPatch,
): EditRoleResult {
  const result = editRole(db, role, currentVersion, patch);
  if (patch.triggers !== undefined) {
    scheduler.reloadRole(role.id);
  }
  return result;
}
