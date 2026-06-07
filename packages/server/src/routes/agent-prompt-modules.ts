import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PromptModuleDefinitionSchema } from "@clobber/shared";
import { enumerateDefaultPromptModules } from "@clobber/runtime";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { WithAgentAuthDeps } from "./_with-agent-auth.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";

// #551 AC4 — agent-facing content-edit route. Resolves the workspace from the
// caller's session (no agent cd / path-rediscovery); wraps the same catalog write
// as PUT /workspaces/:id/prompt-modules/:name behind agent auth.
//   PUT /agent/prompt-modules/:name  → "prompt-modules.edit"

const CATALOG_SUBDIR = ".clobber/prompt-modules";
const MODULE_FILE = "prompt-module.json";

interface NamedParams {
  name: string;
}

export interface AgentPromptModulesRouteDeps extends WithAgentAuthDeps {
  readonly workspaces: Pick<WorkspaceStore, "get">;
}

export function registerAgentPromptModulesRoutes(
  app: FastifyInstance,
  deps: AgentPromptModulesRouteDeps,
): void {
  app.put<{ Params: NamedParams }>(
    "/agent/prompt-modules/:name",
    withAgentAuth<{ Params: NamedParams }>(
      "prompt-modules.edit",
      deps,
      async (request, reply, { session }) => {
        const ws = deps.workspaces.get(session.workspace_id);
        if (ws === null) {
          reply.code(500);
          return { error: "workspace not found for session" };
        }
        const name = request.params.name;
        const defaultNames = new Set(enumerateDefaultPromptModules().map((m) => m.name));
        const inWorkspace = existsSync(
          join(ws.repo_path, CATALOG_SUBDIR, name, MODULE_FILE),
        );
        const inDefaults = defaultNames.has(name);
        if (!inWorkspace && !inDefaults) {
          reply.code(404);
          return { error: `prompt-module not found: ${name}` };
        }
        const body = request.body as { definition?: unknown };
        const parsed = PromptModuleDefinitionSchema.safeParse(body?.definition);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid definition", issues: parsed.error.issues };
        }
        const dir = join(ws.repo_path, CATALOG_SUBDIR, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, MODULE_FILE), JSON.stringify(parsed.data, null, 2));
        const shadowed_default = !inWorkspace && inDefaults;
        const source = inDefaults ? "shadows-default" : "workspace";
        return { name, source, shadowed_default };
      },
    ),
  );
}
