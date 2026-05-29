import { z } from "zod";
import type { Session } from "@clobber/shared";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";

export type AgentListState = "busy" | "idle" | "ended";

const AgentListStatesSchema = z.array(z.enum(["busy", "idle", "ended"]));

export interface AgentListingDeps {
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly agents: AgentStore;
  readonly registry: AgentRegistry;
}

/**
 * Parse the `states` query param into the set of states to include. An omitted
 * param resolves to `null`, meaning "live only" — the default `agents list`
 * view. An empty or malformed param is a client error (`"invalid"`).
 */
export function parseAgentStates(
  raw: string | undefined,
): ReadonlySet<AgentListState> | null | "invalid" {
  if (raw === undefined) return null;
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const parsed = AgentListStatesSchema.safeParse(tokens);
  if (!parsed.success || parsed.data.length === 0) return "invalid";
  return new Set(parsed.data);
}

function entryState(deps: AgentListingDeps, s: Session): AgentListState {
  if (s.ended_at !== undefined) return "ended";
  const live = deps.registry.get(s.id);
  return live === null || live.busy ? "busy" : "idle";
}

function buildEntry(
  deps: AgentListingDeps,
  s: Session,
  callerSessionId: string,
): Record<string, unknown> {
  const role = deps.roles.get(s.role_id);
  if (role === null) throw new Error(`role missing for session ${s.id}`);
  const agentRow = s.agent_id === undefined ? null : deps.agents.get(s.agent_id);
  const entry: Record<string, unknown> = {
    session_id: s.id,
    agent_id: s.agent_id,
    role: { id: role.id, name: role.name },
    pid: s.pid,
    state: entryState(deps, s),
    started_at: s.started_at,
    is_caller: s.id === callerSessionId,
  };
  if (agentRow !== null && agentRow.label !== undefined) {
    entry["label"] = agentRow.label;
  }
  return entry;
}

/**
 * List a workspace's agents as floor entries. `states === null` lists live
 * sessions only (busy/idle); a state set widens the source to include ended
 * sessions when asked and filters the result to exactly the requested states —
 * the resolver passes the eligible-state set its command targets.
 */
export function listWorkspaceAgents(
  deps: AgentListingDeps,
  opts: {
    readonly workspaceId: string;
    readonly callerSessionId: string;
    readonly states: ReadonlySet<AgentListState> | null;
  },
): Record<string, unknown>[] {
  const includeEnded = opts.states !== null && opts.states.has("ended");
  const rows = includeEnded
    ? deps.sessions.listForWorkspace(opts.workspaceId)
    : deps.sessions.listActiveForWorkspace(opts.workspaceId);
  const entries = rows.map((s) => buildEntry(deps, s, opts.callerSessionId));
  if (opts.states === null) return entries;
  return entries.filter((e) => opts.states!.has(e["state"] as AgentListState));
}
