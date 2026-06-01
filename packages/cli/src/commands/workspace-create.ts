import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

export const WORKSPACE_CONFIG_FILE = "workspace.config.json";
// Triggers live on the manager role-version, not the workspace config, so the
// example splits them into a second file. The loader spans both seams (#181).
export const MANAGER_TRIGGERS_FILE = "manager-triggers.json";

interface CreateFlags {
  readonly configDir: string;
  readonly json: boolean;
}

function parseCreateFlags(args: readonly string[]): CreateFlags {
  let configDir: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--config") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError("workspace create: --config requires a directory path");
      }
      configDir = value;
      i += 1;
      continue;
    }
    throw new CliUsageError(`workspace create: unknown argument: ${arg}`);
  }
  if (configDir === undefined) {
    throw new CliUsageError(
      "workspace create: --config <dir> is required (a directory holding workspace.config.json)",
    );
  }
  return { configDir, json };
}

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CliUsageError(`workspace create: ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

interface CreatedWorkspace {
  readonly id: string;
  readonly name: string;
}

interface AppliedTriggers {
  // #414 — applying manager triggers advances the role's git pin (no version row).
  readonly branch: string;
  readonly sha: string;
}

interface LoadResult {
  readonly workspace: CreatedWorkspace;
  readonly triggers: AppliedTriggers | null;
}

export async function runCreate(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const { configDir, json } = parseCreateFlags(rest);

  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new CliUsageError(
      `workspace create: ${WORKSPACE_CONFIG_FILE} not found in ${configDir}`,
    );
  }
  const config = readJsonFile(configPath);

  // Seam 1 — create the workspace from workspace.config.json. The server
  // validates against CreateWorkspaceRequestSchema; we send the file as-is.
  const workspace = await request<CreatedWorkspace>(ctx.env, {
    method: "POST",
    path: "/workspaces",
    body: config,
  });

  // Seam 2 — apply the manager role-version's triggers via the operator-level
  // trigger endpoint (#186). The agent-scoped PATCH can't be used here: the
  // caller has no session in the just-created workspace.
  let triggers: AppliedTriggers | null = null;
  const triggersPath = join(configDir, MANAGER_TRIGGERS_FILE);
  if (existsSync(triggersPath)) {
    const triggerList = readJsonFile(triggersPath);
    triggers = await request<AppliedTriggers>(ctx.env, {
      method: "PUT",
      path: `/workspaces/${workspace.id}/roles/manager/triggers`,
      body: { triggers: triggerList },
    });
  }

  const result: LoadResult = { workspace, triggers };
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(
    `created workspace ${workspace.name} (id: ${workspace.id})\n`,
  );
  ctx.stdout.write(
    triggers === null
      ? `no ${MANAGER_TRIGGERS_FILE} found — manager triggers left unset\n`
      : `applied manager triggers -> ${triggers.sha.slice(0, 8)}\n`,
  );
  return 0;
}
