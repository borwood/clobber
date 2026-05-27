import type { FastifyInstance } from "fastify";
import { IDLE_WAKE_PROGRAM_NAME, type LatestAgentStatus } from "@clobber/shared";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentStatusStore } from "../agent-status-store.ts";
import { officePathFor } from "../office-store.ts";
import { peekOffice, type OfficePeek } from "../office-peek.ts";

interface IdParam {
  id: string;
}

interface SessionView {
  id: string;
  started_at: number;
  busy: boolean;
  latest_status: LatestAgentStatus | null;
}

interface OfficeCard {
  agent_id: string;
  label: string | null;
  role: { id: string; name: string };
  active_session: SessionView | null;
  last_started_at: number | null;
  office: OfficePeek;
  // The wake-programs the office affordance can offer: the built-in `idle`
  // first, then the role's declared programs (#213).
  wake_programs: string[];
}

interface DeskCard {
  agent_id: string;
  label: string | null;
  role: { id: string; name: string };
  session: SessionView;
}

export interface WhiteboardRouteDeps {
  readonly workspaces: WorkspaceStore;
  readonly agents: AgentStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly sessions: SessionStore;
  readonly registry: AgentRegistry;
  readonly agentStatuses: AgentStatusStore;
}

export function registerWhiteboardRoutes(
  app: FastifyInstance,
  deps: WhiteboardRouteDeps,
): void {
  const { workspaces, agents, roles, roleVersions, sessions, registry, agentStatuses } = deps;

  app.get<{ Params: IdParam }>(
    "/workspaces/:id/whiteboard",
    async (request, reply) => {
      const workspace = workspaces.get(request.params.id);
      if (workspace === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }

      const allAgents = agents.listForWorkspace(workspace.id);
      const activeSessions = sessions.listActiveForWorkspace(workspace.id);
      const allWorkspaceSessions = sessions.listForWorkspace(workspace.id);

      const offices: OfficeCard[] = [];
      const desks: DeskCard[] = [];

      for (const agent of allAgents) {
        const role = roles.get(agent.role_id);
        if (role === null) continue;

        const active = activeSessions.find((s) => s.agent_id === agent.id);
        const live = active === undefined ? null : registry.get(active.id);
        const status = active === undefined ? null : agentStatuses.get(active.id);
        const latest_status: LatestAgentStatus | null =
          status === null
            ? null
            : { state: status.state, summary: status.summary, updated_at: status.updated_at };

        if (role.persistent) {
          const lastSession = allWorkspaceSessions.find((s) => s.agent_id === agent.id);
          offices.push({
            agent_id: agent.id,
            label: agent.label === undefined ? null : agent.label,
            role: { id: role.id, name: role.name },
            wake_programs: wakeProgramNamesFor(roleVersions, role.current_version_id),
            active_session:
              active === undefined
                ? null
                : {
                    id: active.id,
                    started_at: active.started_at,
                    busy: live === null ? false : live.busy,
                    latest_status,
                  },
            last_started_at: lastSession === undefined ? null : lastSession.started_at,
            office: peekOffice(officePathFor(workspace.repo_path, agent.id)),
          });
          continue;
        }

        if (active === undefined) continue;
        desks.push({
          agent_id: agent.id,
          label: agent.label === undefined ? null : agent.label,
          role: { id: role.id, name: role.name },
          session: {
            id: active.id,
            started_at: active.started_at,
            busy: live === null ? false : live.busy,
            latest_status,
          },
        });
      }

      return { offices, desks };
    },
  );
}

// `idle` (the universal built-in) followed by the role's declared wake-programs,
// in order. The office affordance offers exactly these as the human's choices.
function wakeProgramNamesFor(
  roleVersions: RoleVersionStore,
  versionId: string | undefined,
): string[] {
  const names = [IDLE_WAKE_PROGRAM_NAME];
  if (versionId === undefined) return names;
  const bundle = roleVersions.loadAsBundle(versionId);
  if (bundle === null) return names;
  for (const program of bundle.wakePrograms) names.push(program.name);
  return names;
}
