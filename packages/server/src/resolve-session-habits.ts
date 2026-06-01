import { execSync } from "node:child_process";
import type { Habit, Session } from "@clobber/shared";
import { embodyRole, sessionPin, type RoleEmbodimentDeps } from "./embody-role.ts";
import type { RoleStore } from "./role-store.ts";

// #271 — the production self.* habit resolver: embody the firing session's role
// (the SAME pin it spawned with, so a habit-bearing commit-pinned role resolves
// its habits) and read the bundle's habits. A role with no current pin, or a
// row-backed role (Phase 0 stores no habit column), yields none.
export interface SessionHabitsResolverDeps extends RoleEmbodimentDeps {
  readonly roles: RoleStore;
}

export function createSessionHabitsResolver(
  deps: SessionHabitsResolverDeps,
): (session: Session) => readonly Habit[] {
  return (session) => {
    const role = deps.roles.get(session.role_id);
    if (role === null) return [];
    const bundle = embodyRole(role, sessionPin(session, role), deps);
    if (bundle === null) return [];
    return bundle.habits;
  };
}

// An `inject` habit's optional `bash`, run in the agent's cwd. Server-side eval
// of arbitrary shell is the documented risk of the `inject.bash` field; the gate
// guards what habits a role may author, the cwd scopes where it runs.
export function runHabitBash(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: "utf8", timeout: 5000 });
}
