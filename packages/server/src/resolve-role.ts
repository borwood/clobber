import type { Role } from "@clobber/shared";
import type { RoleStore } from "./role-store.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Routes address a role by either its UUID or its workspace-unique name. A
// UUID is resolved globally; a name is resolved within the given workspace.
export function resolveRoleByIdOrName(
  roles: Pick<RoleStore, "get" | "findInWorkspace">,
  idOrName: string,
  workspaceId: string,
): Role | null {
  return UUID_RE.test(idOrName)
    ? roles.get(idOrName)
    : roles.findInWorkspace(workspaceId, idOrName);
}
