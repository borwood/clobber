import type { Role } from "@clobber/shared";
import type { RoleStore } from "./role-store.ts";

const MANAGER_NAME = "manager";

export function ensureManagerRole(roles: RoleStore): Role {
  const existing = roles.findByName(MANAGER_NAME);
  if (existing !== null) return existing;
  return roles.create({
    name: MANAGER_NAME,
    persistent: true,
    permission_mode: "bypassPermissions",
    allowed_tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  });
}
