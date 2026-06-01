import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PromptModuleDefinitionSchema, PromptModuleRefsSchema } from "@clobber/shared";
import { enumerateDefaultPromptModules } from "@clobber/runtime";
import type { WorkspaceStore } from "../workspace-store.ts";
import {
  resolvePromptModuleCatalogWithSources,
  type PromptModuleWithSource,
} from "../workspace-prompt-module-catalog.ts";

// #445 — prompt-module catalog CRUD. The server owns these routes because:
//   1. It already owns resolvePromptModuleCatalog.
//   2. It knows the workspace's repo_path.
//   3. Its DB can answer "which roles ref this module" for delete-safety.
// The CLI is a thin client calling these; no FS access in the CLI.

const CATALOG_SUBDIR = ".clobber/prompt-modules";
const MODULE_FILE = "prompt-module.json";

interface Params {
  id: string;
}

interface NamedParams {
  id: string;
  name: string;
}

interface DeleteQuerystring {
  force?: string;
}

// Roles in the workspace that have `moduleName` in their prompt-module refs.
// Checks both row-backed roles (role_versions.seed_refs_json) and commit-pinned
// roles (materialized_role_cache.contract_json → seedRefs).
function rolesReferencingModule(
  db: Database,
  workspaceId: string,
  moduleName: string,
): Array<{ id: string; name: string }> {
  const rowBacked = db
    .prepare(
      `SELECT r.id, r.name, rv.seed_refs_json
       FROM roles r
       JOIN role_versions rv ON rv.id = r.current_version_id
       WHERE r.workspace_id = ?`,
    )
    .all(workspaceId) as Array<{ id: string; name: string; seed_refs_json: string }>;

  const commitPinned = db
    .prepare(
      `SELECT r.id, r.name, mrc.contract_json
       FROM roles r
       JOIN materialized_role_cache mrc ON mrc.sha = r.current_commit_sha
       WHERE r.workspace_id = ?
         AND r.current_commit_sha IS NOT NULL
         AND r.current_version_id IS NULL`,
    )
    .all(workspaceId) as Array<{ id: string; name: string; contract_json: string }>;

  const result: Array<{ id: string; name: string }> = [];

  for (const row of rowBacked) {
    // Validate at the boundary (#431, flagged by the #459 adversary): parse the
    // row-backed refs through the domain schema instead of a raw cast.
    const refs = PromptModuleRefsSchema.parse(JSON.parse(row.seed_refs_json));
    if (refs.some((r) => r.name === moduleName)) {
      result.push({ id: row.id, name: row.name });
    }
  }

  for (const row of commitPinned) {
    const contract = JSON.parse(row.contract_json) as {
      seedRefs?: Array<{ name: string }>;
    };
    if (contract.seedRefs?.some((r) => r.name === moduleName)) {
      result.push({ id: row.id, name: row.name });
    }
  }

  return result;
}

function modulePath(repoPath: string, name: string): string {
  return join(repoPath, CATALOG_SUBDIR, name, MODULE_FILE);
}

function workspaceModuleExists(repoPath: string, name: string): boolean {
  return existsSync(modulePath(repoPath, name));
}

function writeModule(repoPath: string, name: string, definition: unknown): void {
  const dir = join(repoPath, CATALOG_SUBDIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MODULE_FILE), JSON.stringify(definition, null, 2));
}

export function registerWorkspacePromptModuleRoutes(
  app: FastifyInstance,
  deps: {
    readonly db: Database;
    readonly workspaces: Pick<WorkspaceStore, "get">;
  },
): void {
  const { db, workspaces } = deps;

  // GET /workspaces/:id/prompt-modules — resolved catalog with source classification
  app.get<{ Params: Params }>("/workspaces/:id/prompt-modules", async (request, reply) => {
    const ws = workspaces.get(request.params.id);
    if (ws === null) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    const modules = resolvePromptModuleCatalogWithSources(ws.repo_path);
    return modules.map((m) => ({ name: m.name, kind: m.definition.kind, source: m.source }));
  });

  // GET /workspaces/:id/prompt-modules/:name — full definition + source
  app.get<{ Params: NamedParams }>(
    "/workspaces/:id/prompt-modules/:name",
    async (request, reply) => {
      const ws = workspaces.get(request.params.id);
      if (ws === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      const modules = resolvePromptModuleCatalogWithSources(ws.repo_path);
      const found = modules.find((m) => m.name === request.params.name);
      if (found === undefined) {
        reply.code(404);
        return { error: `prompt-module not found: ${request.params.name}` };
      }
      return { name: found.name, source: found.source, definition: found.definition };
    },
  );

  // POST /workspaces/:id/prompt-modules/:name — create
  // Refuses if a workspace module of that name already exists.
  app.post<{ Params: NamedParams }>(
    "/workspaces/:id/prompt-modules/:name",
    async (request, reply) => {
      const ws = workspaces.get(request.params.id);
      if (ws === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      const name = request.params.name;

      if (workspaceModuleExists(ws.repo_path, name)) {
        reply.code(409);
        return {
          error: `workspace module '${name}' already exists — use 'edit' to replace it`,
        };
      }

      const body = request.body as { definition?: unknown };
      const parsed = PromptModuleDefinitionSchema.safeParse(body?.definition);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid definition", issues: parsed.error.issues };
      }

      writeModule(ws.repo_path, name, parsed.data);

      const defaultNames = new Set(enumerateDefaultPromptModules().map((m) => m.name));
      const source: PromptModuleWithSource["source"] = defaultNames.has(name)
        ? "shadows-default"
        : "workspace";

      reply.code(201);
      return { name, source };
    },
  );

  // PUT /workspaces/:id/prompt-modules/:name — edit (replace)
  // Editing a shipped-default name forks it into a workspace shadow.
  // Returns 404 for names unknown to both workspace and defaults.
  app.put<{ Params: NamedParams }>(
    "/workspaces/:id/prompt-modules/:name",
    async (request, reply) => {
      const ws = workspaces.get(request.params.id);
      if (ws === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      const name = request.params.name;

      const defaultNames = new Set(enumerateDefaultPromptModules().map((m) => m.name));
      const inWorkspace = workspaceModuleExists(ws.repo_path, name);
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

      writeModule(ws.repo_path, name, parsed.data);

      // Shadowing a default for the first time — caller should surface this.
      const shadowed_default = !inWorkspace && inDefaults;
      const source: PromptModuleWithSource["source"] = inDefaults
        ? "shadows-default"
        : "workspace";

      return { name, source, shadowed_default };
    },
  );

  // DELETE /workspaces/:id/prompt-modules/:name — delete (ref-safe)
  // Hard guard: pure shipped defaults cannot be deleted even with force=true.
  // Force guard: roles that ref the module → refuse unless ?force=true.
  app.delete<{ Params: NamedParams; Querystring: DeleteQuerystring }>(
    "/workspaces/:id/prompt-modules/:name",
    async (request, reply) => {
      const ws = workspaces.get(request.params.id);
      if (ws === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      const name = request.params.name;
      const force = request.query.force === "true";

      const defaultNames = new Set(enumerateDefaultPromptModules().map((m) => m.name));
      const inWorkspace = workspaceModuleExists(ws.repo_path, name);
      const inDefaults = defaultNames.has(name);

      if (!inWorkspace && !inDefaults) {
        reply.code(404);
        return { error: `prompt-module not found: ${name}` };
      }

      // Hard guard: cannot delete a pure shipped default (workspace file absent).
      if (!inWorkspace && inDefaults) {
        reply.code(422);
        return {
          error: `'${name}' is a shipped default with no workspace override — cannot delete`,
        };
      }

      // Force guard: refuse if any role refs the module AND the module would vanish
      // from the catalog (pure workspace module, not a shadow — shadows leave the
      // shipped default in place, so refs are still satisfied post-delete).
      if (!inDefaults) {
        const blockingRoles = rolesReferencingModule(db, request.params.id, name);
        if (blockingRoles.length > 0 && !force) {
          reply.code(409);
          return {
            error: `'${name}' is still ref'd by ${blockingRoles.length} role(s) — use --force to override`,
            blocking_roles: blockingRoles,
          };
        }
      }

      const dir = join(ws.repo_path, CATALOG_SUBDIR, name);
      rmSync(dir, { recursive: true, force: true });

      return { name, deleted: true };
    },
  );
}
