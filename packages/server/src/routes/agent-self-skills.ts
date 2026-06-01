import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { RoleSkillSchema, type RoleSkill, type Session } from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { AgentStatusLogStore } from "../agent-status-log-store.ts";
import type { RoleContentCache } from "../role-content-cache.ts";
import type { ForkRef } from "../role-repo.ts";
import type { WorkspaceRoleRepos } from "../workspace-role-repos.ts";
import type { TriggerScheduler } from "../trigger-scheduler.ts";
import { patchRoleThroughPin } from "../role-commit.ts";
import { deskFor, type RouteResult } from "../role-checkout-context.ts";
import { resolveCurrentRoleVersion } from "../resolve-role-content.ts";
import { loadWorkspaceSkillCatalog } from "../workspace-skill-catalog.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";

const GrantBodySchema = z.object({
  name: z.string().min(1),
});

interface NameParam {
  name: string;
}

export interface AgentSelfSkillsRouteDeps {
  readonly db: Database;
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly workspaces: WorkspaceStore;
  readonly agentStatusLog: AgentStatusLogStore;
  readonly scheduler: Pick<TriggerScheduler, "reloadRole">;
  // #361/#414 — git-as-truth wiring, so a commit-pinned persistent role's skills
  // are read from the materialized cache and a self-grant ADVANCES THE PIN
  // (commits onto the per-workspace clone) rather than demoting to a version row.
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
  readonly roleForks?: ReadonlyMap<string, ForkRef>;
  readonly workspaceRepos?: WorkspaceRoleRepos;
}

interface SelfSkillsContext {
  readonly roleId: string;
  readonly currentSkills: RoleSkill[];
  readonly workspace: NonNullable<ReturnType<WorkspaceStore["get"]>>;
}

type SelfSkillsResolution =
  | { readonly ok: true; readonly ctx: SelfSkillsContext }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
    };

function resolveSelfSkillsContext(
  sessionRoleId: string,
  sessionWorkspaceId: string,
  deps: AgentSelfSkillsRouteDeps,
): SelfSkillsResolution {
  const role = deps.roles.get(sessionRoleId);
  if (role === null) {
    return { ok: false, status: 500, error: "role missing for session" };
  }
  if (!role.persistent) {
    return {
      ok: false,
      status: 403,
      error: "self-grant is only allowed for persistent roles",
    };
  }
  const version = resolveCurrentRoleVersion(role, deps);
  if (version === null) {
    return { ok: false, status: 500, error: "role has no current version" };
  }
  const workspace = deps.workspaces.get(sessionWorkspaceId);
  if (workspace === null) {
    return { ok: false, status: 404, error: "workspace not found" };
  }
  return {
    ok: true,
    ctx: {
      roleId: role.id,
      // Validate at the boundary (#431): a row-backed role's skills_json is read
      // here without going through role-version-store's loadAsBundle validation.
      // A raw cast would re-hydrate a skill persisted before a RoleSkill field
      // existed with that field `undefined`; parsing through the schema rejects
      // the stale shape at the boundary instead of serving a corrupt skill.
      currentSkills: z.array(RoleSkillSchema).parse(JSON.parse(version.skills_json)),
      workspace,
    },
  };
}

// Commit the new skill set onto the role's branch (advancing the pin). Returns
// the route result verbatim so a 409 (an open checkout for the role) or 422
// surfaces to the caller instead of being swallowed.
function applySkills(
  ctx: SelfSkillsContext,
  nextSkills: readonly RoleSkill[],
  deps: AgentSelfSkillsRouteDeps,
  session: Session,
): RouteResult {
  const role = deps.roles.get(ctx.roleId);
  if (role === null) throw new Error("role disappeared");
  if (role.workspace_id === undefined) {
    throw new Error(`self-skills role ${role.name} has no workspace`);
  }
  const deskDir = session.agent_id === undefined ? undefined : deskFor(deps, session);
  return patchRoleThroughPin(deps, {
    role,
    workspaceId: role.workspace_id,
    ...(deskDir === undefined ? {} : { deskDir }),
    apply: (current) => ({ ...current, skills: [...nextSkills] }),
    message: `self-skills edit on ${role.name}`,
  });
}

export function registerAgentSelfSkillsRoutes(
  app: FastifyInstance,
  deps: AgentSelfSkillsRouteDeps,
): void {
  app.get(
    "/agent/self-skills",
    withAgentAuth(
      "self-skills.list",
      deps,
      async (_request, reply, { session }) => {
        const resolved = resolveSelfSkillsContext(
          session.role_id,
          session.workspace_id,
          deps,
        );
        if (!resolved.ok) {
          reply.code(resolved.status);
          return { error: resolved.error };
        }
        const { ctx } = resolved;
        return {
          policy: ctx.workspace.manager_skill_policy,
          granted: ctx.currentSkills,
          catalog: loadWorkspaceSkillCatalog(ctx.workspace.repo_path),
        };
      },
    ),
  );

  app.post(
    "/agent/self-skills",
    withAgentAuth(
      "self-skills.grant",
      deps,
      async (request, reply, { session }) => {
        const parsed = GrantBodySchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400);
          return {
            error: "invalid grant request",
            issues: parsed.error.issues,
          };
        }
        const resolved = resolveSelfSkillsContext(
          session.role_id,
          session.workspace_id,
          deps,
        );
        if (!resolved.ok) {
          reply.code(resolved.status);
          return { error: resolved.error };
        }
        const { ctx } = resolved;
        const policy = ctx.workspace.manager_skill_policy;
        if (!policy.allow_self_grant) {
          reply.code(403);
          return {
            error: "self-grant disabled by workspace policy",
          };
        }
        if (!policy.allowed_skills.includes(parsed.data.name)) {
          reply.code(403);
          return {
            error: `skill '${parsed.data.name}' not in workspace allowed_skills`,
          };
        }
        const catalog = loadWorkspaceSkillCatalog(ctx.workspace.repo_path);
        const entry = catalog.find((s) => s.name === parsed.data.name);
        if (entry === undefined) {
          reply.code(404);
          return {
            error: `skill '${parsed.data.name}' not in workspace catalog`,
          };
        }
        if (ctx.currentSkills.some((s) => s.name === parsed.data.name)) {
          reply.code(409);
          return {
            error: `skill '${parsed.data.name}' already granted`,
          };
        }
        const next = [...ctx.currentSkills, entry];
        const result = applySkills(ctx, next, deps, session);
        if (result.status !== 200) {
          reply.code(result.status);
          return result.body;
        }
        const committed = result.body as { branch: string; sha: string };
        deps.agentStatusLog.append({
          agent_id: session.agent_id!,
          session_id: session.id,
          kind: "skill-self-grant",
          state: "granted",
          summary: `granted skill '${parsed.data.name}'`,
          details: {
            action: "grant",
            skill: parsed.data.name,
            role_id: ctx.roleId,
            before: ctx.currentSkills.map((s) => s.name),
            after: next.map((s) => s.name),
          },
        });
        return {
          role_id: ctx.roleId,
          branch: committed.branch,
          sha: committed.sha,
          no_new_version: true,
          granted: next,
        };
      },
    ),
  );

  app.delete<{ Params: NameParam }>(
    "/agent/self-skills/:name",
    withAgentAuth<{ Params: NameParam }>(
      "self-skills.release",
      deps,
      async (request, reply, { session }) => {
        const { name } = request.params;
        const resolved = resolveSelfSkillsContext(
          session.role_id,
          session.workspace_id,
          deps,
        );
        if (!resolved.ok) {
          reply.code(resolved.status);
          return { error: resolved.error };
        }
        const { ctx } = resolved;
        if (!ctx.workspace.manager_skill_policy.allow_self_grant) {
          reply.code(403);
          return { error: "self-grant disabled by workspace policy" };
        }
        const next = ctx.currentSkills.filter((s) => s.name !== name);
        if (next.length === ctx.currentSkills.length) {
          reply.code(404);
          return { error: `skill '${name}' is not currently granted` };
        }
        const result = applySkills(ctx, next, deps, session);
        if (result.status !== 200) {
          reply.code(result.status);
          return result.body;
        }
        const committed = result.body as { branch: string; sha: string };
        deps.agentStatusLog.append({
          agent_id: session.agent_id!,
          session_id: session.id,
          kind: "skill-self-grant",
          state: "released",
          summary: `released skill '${name}'`,
          details: {
            action: "release",
            skill: name,
            role_id: ctx.roleId,
            before: ctx.currentSkills.map((s) => s.name),
            after: next.map((s) => s.name),
          },
        });
        return {
          role_id: ctx.roleId,
          branch: committed.branch,
          sha: committed.sha,
          no_new_version: true,
          granted: next,
        };
      },
    ),
  );
}
