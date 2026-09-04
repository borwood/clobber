import type { Agent, Role, Workspace } from "@clobber/shared";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";

export interface PersistentAgentReuseDeps {
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly workspaceRoles: WorkspaceRoleStore;
}

export interface AgentRowCapacityError {
  readonly ok: false;
  readonly status: 403;
  readonly error: "role at capacity";
  readonly ceiling: number;
  readonly active: number;
}

// A persistent role's identity is the agent row, not the session (#698 review):
// checkCapacity gates spawn on *active-session* count, so a session-less
// existing agent (established at workspace-create, or left behind by an ended
// session) is invisible to it — a second /spawn for the same persistent role
// would create a SECOND agent row and register a SECOND copy of the role's
// triggers, double-dispatching workspace-open et al. Find that reusable agent
// so the caller can wake it instead of minting a new identity.
export function findReusableSessionlessAgent(
  deps: PersistentAgentReuseDeps,
  workspace: Workspace,
  role: Role,
): Agent | null {
  const roleAgents = deps.agents
    .listForWorkspace(workspace.id)
    .filter((a) => a.role_id === role.id);
  if (roleAgents.length === 0) return null;
  const activeAgentIds = new Set(
    deps.sessions.listActiveForWorkspace(workspace.id).map((s) => s.agent_id),
  );
  return roleAgents.find((a) => !activeAgentIds.has(a.id)) ?? null;
}

// The agent-row counterpart to spawn-pipeline's session-based `checkCapacity`,
// for persistent roles only: a persistent role's ceiling bounds how many agent
// IDENTITIES may exist, not just how many may be concurrently live. Callers
// check `findReusableSessionlessAgent` first — this only gates the case where
// every existing agent for the role already holds a live session.
export function checkAgentRowCapacity(
  deps: PersistentAgentReuseDeps,
  workspace: Workspace,
  role: Role,
): AgentRowCapacityError | null {
  const ceilingRow = deps.workspaceRoles.getCeiling(workspace.id, role.id);
  const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
  const existing = deps.agents
    .listForWorkspace(workspace.id)
    .filter((a) => a.role_id === role.id).length;
  if (existing >= ceiling) {
    return { ok: false, status: 403, error: "role at capacity", ceiling, active: existing };
  }
  return null;
}
