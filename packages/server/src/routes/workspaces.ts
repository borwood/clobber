import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceConfigRequestSchema,
} from "@clobber/shared";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { TriggerScheduler } from "../trigger-scheduler.ts";
import { seedWorkspaceRoles } from "../seed-workspace-roles.ts";
import { validateWorkspacePath } from "../validate-workspace-path.ts";

interface IdParam {
  id: string;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    workspaces: WorkspaceStore;
    scheduler: Pick<TriggerScheduler, "reloadRole" | "fireWorkspaceOpen">;
  },
): void {
  const { db, workspaces, scheduler } = deps;

  app.post("/workspaces", async (request, reply) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid workspace request", issues: parsed.error.issues };
    }
    const validation = validateWorkspacePath(parsed.data.repo_path);
    if (!validation.ok) {
      reply.code(400);
      return { error: validation.error };
    }
    if (workspaces.findByName(parsed.data.name) !== null) {
      reply.code(409);
      return { error: "workspace name already exists" };
    }
    const created = workspaces.create(parsed.data);
    seedWorkspaceRoles(db, created.id);
    reply.code(201);
    return created;
  });

  app.get("/workspaces", async () => workspaces.list());

  app.get<{ Params: IdParam }>("/workspaces/:id", async (request, reply) => {
    const found = workspaces.get(request.params.id);
    if (found === null) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    return found;
  });

  app.patch<{ Params: IdParam }>(
    "/workspaces/:id",
    async (request, reply) => {
      const parsed = UpdateWorkspaceConfigRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid workspace config", issues: parsed.error.issues };
      }
      const updated = workspaces.updateConfig(request.params.id, {
        ...(parsed.data.setting_sources === undefined
          ? {}
          : { setting_sources: parsed.data.setting_sources }),
        ...(parsed.data.wake_prompt === undefined
          ? {}
          : { wake_prompt: parsed.data.wake_prompt }),
        ...(parsed.data.role_edit_policy === undefined
          ? {}
          : { role_edit_policy: parsed.data.role_edit_policy }),
        ...(parsed.data.trigger_overrides === undefined
          ? {}
          : { trigger_overrides: parsed.data.trigger_overrides }),
        ...(parsed.data.final_report_callback === undefined
          ? {}
          : { final_report_callback: parsed.data.final_report_callback }),
        ...(parsed.data.boot_context_provider === undefined
          ? {}
          : { boot_context_provider: parsed.data.boot_context_provider }),
        ...(parsed.data.spawn_worktree === undefined
          ? {}
          : { spawn_worktree: parsed.data.spawn_worktree }),
        ...(parsed.data.file_size_policy === undefined
          ? {}
          : { file_size_policy: parsed.data.file_size_policy }),
        ...(parsed.data.manager_skill_policy === undefined
          ? {}
          : { manager_skill_policy: parsed.data.manager_skill_policy }),
      });
      if (updated === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      if (parsed.data.trigger_overrides !== undefined) {
        for (const roleId of Object.keys(parsed.data.trigger_overrides)) {
          scheduler.reloadRole(roleId);
        }
      }
      return updated;
    },
  );

  app.post<{ Params: IdParam }>(
    "/workspaces/:id/open",
    async (request, reply) => {
      const workspace = workspaces.get(request.params.id);
      if (workspace === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      const payload = { workspace_id: workspace.id, opened_at: Date.now() };
      const result = await scheduler.fireWorkspaceOpen(workspace.id, payload);
      return { dispatched: result.dispatched };
    },
  );

  app.delete<{ Params: IdParam }>("/workspaces/:id", async (request, reply) => {
    const removed = workspaces.delete(request.params.id);
    if (!removed) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    reply.code(204);
    return null;
  });
}
