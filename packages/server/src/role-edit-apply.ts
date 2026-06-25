import {
  RoleEditRequestSchema,
  ROLE_EDIT_PIN_FIELDS,
  type Role,
  type RoleEditRequest,
} from "@clobber/shared";
import { patchRoleThroughPin, triggersRequirePersistent } from "./role-commit.ts";
import type { RoleCheckoutDeps, RouteResult } from "./role-checkout-context.ts";
import type { RoleTreeContract } from "./role-tree.ts";

// #680 — the single body-handling path behind every role-content edit. Both the
// agent-scoped PATCH /agent/roles/:id and the operator PATCH
// /workspaces/:wid/roles/:rid resolve the role/workspace under their own auth,
// then hand the raw body here. Forbidden-key policy, validation, the
// metadata-only `description` fast-path, the persistent-only trigger guard, and
// the git-pin patch all live in one place so the two routes can't drift.

export function editAdvancesPin(patch: RoleEditRequest): boolean {
  return ROLE_EDIT_PIN_FIELDS.some((key) => patch[key] !== undefined);
}

export interface ApplyRoleEditInput {
  readonly rawBody: unknown;
  readonly role: Role;
  readonly workspaceId: string;
  readonly forbiddenKeys: readonly string[];
  // Present only for agent-scoped edits: refuses to clobber an open checkout on
  // the calling session's desk. Operator edits have no desk and omit it.
  readonly deskDir?: string;
  readonly message: string;
}

export function applyRoleEdit(
  deps: RoleCheckoutDeps,
  input: ApplyRoleEditInput,
): RouteResult {
  const rawBody =
    input.rawBody === null || typeof input.rawBody !== "object"
      ? null
      : (input.rawBody as Record<string, unknown>);
  if (rawBody === null) {
    return { status: 400, body: { error: "edit body must be a JSON object" } };
  }
  for (const key of input.forbiddenKeys) {
    if (key in rawBody) {
      return { status: 400, body: { error: `${key} is not editable` } };
    }
  }
  const parsed = RoleEditRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid edit request", issues: parsed.error.issues } };
  }
  const patch = parsed.data;
  const advancesPin = editAdvancesPin(patch);
  if (!advancesPin && patch.description === undefined) {
    return {
      status: 400,
      body: {
        error: `edit body must include at least one of ${[...ROLE_EDIT_PIN_FIELDS, "description"].join(", ")}`,
      },
    };
  }
  if (triggersRequirePersistent(input.role, patch.triggers)) {
    return { status: 422, body: { error: "triggers are only allowed on persistent roles" } };
  }

  // Metadata-only: `description` lives in the roles row, not the git tree, so a
  // description-only edit updates it without advancing the pin.
  if (!advancesPin) {
    const description = patch.description;
    if (description === undefined) {
      throw new Error("unreachable: non-pin-advancing edit without a description");
    }
    deps.roles.updateDescription(input.role.id, description);
    return { status: 200, body: { role_id: input.role.id, description } };
  }

  return patchRoleThroughPin(deps, {
    role: input.role,
    workspaceId: input.workspaceId,
    ...(input.deskDir === undefined ? {} : { deskDir: input.deskDir }),
    apply: (current: RoleTreeContract): RoleTreeContract => ({
      ...current,
      ...(patch.system_prompt === undefined ? {} : { systemPrompt: patch.system_prompt }),
      ...(patch.skills === undefined ? {} : { skills: patch.skills }),
      ...(patch.allowed_tools === undefined ? {} : { allowedTools: patch.allowed_tools }),
      ...(patch.triggers === undefined ? {} : { triggers: patch.triggers }),
      ...(patch.prompt_module_refs === undefined ? {} : { seedRefs: patch.prompt_module_refs }),
      ...(patch.wake_programs === undefined ? {} : { wakePrograms: patch.wake_programs }),
    }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    message: input.message,
  });
}
