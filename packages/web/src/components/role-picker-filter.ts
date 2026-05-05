import type { WorkspaceRoleAssignment } from "../api.ts";

export function filterRoleAssignments(
  assignments: readonly WorkspaceRoleAssignment[],
  query: string,
): readonly WorkspaceRoleAssignment[] {
  const spawnable = assignments.filter((a) => a.max_concurrent > 0);
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return spawnable;
  return spawnable.filter((a) => {
    if (a.role.name.toLowerCase().includes(trimmed)) return true;
    if (a.role.description !== undefined &&
        a.role.description.toLowerCase().includes(trimmed)) return true;
    return false;
  });
}
