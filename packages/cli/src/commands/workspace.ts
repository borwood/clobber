import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

const SUBCOMMANDS = ["create"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(name: string): name is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(name);
}

const WORKSPACE_CONFIG_FILE = "workspace.config.json";
// Triggers live on the manager role-version, not the workspace config, so the
// example splits them into a second file. The loader spans both seams (#181).
const MANAGER_TRIGGERS_FILE = "manager-triggers.json";

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
  readonly version: number;
}

interface LoadResult {
  readonly workspace: CreatedWorkspace;
  readonly triggers: AppliedTriggers | null;
}

async function runCreate(ctx: CommandContext, rest: readonly string[]): Promise<number> {
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
      : `applied manager triggers -> v${triggers.version}\n`,
  );
  return 0;
}

const WORKSPACE_USAGE = `usage: clobber workspace create --config <dir> [--json]

Load a workspace from an example directory in one step. Reads
${WORKSPACE_CONFIG_FILE} and ${MANAGER_TRIGGERS_FILE} from <dir> and drives the
existing engine seams:

  1. POST /workspaces                          from ${WORKSPACE_CONFIG_FILE}
  2. PUT  /workspaces/:id/roles/manager/triggers from ${MANAGER_TRIGGERS_FILE}

${WORKSPACE_CONFIG_FILE} is required; ${MANAGER_TRIGGERS_FILE} is optional. The
worker SDLC profile is the shipped role default — nothing to load.

Flags:
      --config <dir>   Directory holding the workspace config files (required).
      --json           Emit the created workspace + applied triggers as JSON.

Example:
  clobber workspace create --config examples/clobber-on-clobber/`;

export const workspaceCommand: Command = {
  name: "workspace",
  summary: "Load a workspace from a config directory (create + apply triggers).",
  usage: WORKSPACE_USAGE,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub === undefined) {
      throw new CliUsageError("workspace: missing subcommand (try `workspace create --config <dir>`)");
    }
    if (!isSubcommand(sub)) {
      throw new CliUsageError(`workspace: unknown subcommand: ${sub}`);
    }
    return runCreate(ctx, rest);
  },
};
