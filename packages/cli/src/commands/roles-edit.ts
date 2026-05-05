import { readFileSync } from "node:fs";
import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface RoleSkill {
  readonly name: string;
  readonly body: string;
}

interface RoleDetailResponse {
  readonly id: string;
  readonly name: string;
  readonly current_version: {
    readonly skills: readonly RoleSkill[];
  };
}

interface EditResponse {
  readonly role_id: string;
  readonly version_id?: string;
  readonly version?: number;
  readonly description?: string;
}

interface EditFlags {
  readonly target: string;
  readonly json: boolean;
  readonly systemPromptFile?: string;
  readonly systemPromptStdin: boolean;
  readonly allowedTools?: readonly string[];
  readonly addSkills: ReadonlyArray<{ readonly name: string; readonly file: string }>;
  readonly removeSkills: readonly string[];
  readonly description?: string;
  readonly descriptionFile?: string;
}

function parseFlags(args: readonly string[]): EditFlags {
  let target: string | undefined;
  let json = false;
  let systemPromptFile: string | undefined;
  let systemPromptStdin = false;
  let allowedTools: readonly string[] | undefined;
  const addSkills: Array<{ name: string; file: string }> = [];
  const removeSkills: string[] = [];
  let description: string | undefined;
  let descriptionFile: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--system-prompt-file") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError("roles edit: --system-prompt-file requires a path");
      }
      systemPromptFile = value;
      i += 1;
      continue;
    }
    if (arg === "--system-prompt") {
      const value = args[i + 1];
      if (value !== "-") {
        throw new CliUsageError(
          "roles edit: --system-prompt only supports `-` (stdin); use --system-prompt-file FILE for a file",
        );
      }
      systemPromptStdin = true;
      i += 1;
      continue;
    }
    if (arg === "--allowed-tools") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError(
          "roles edit: --allowed-tools requires a comma-separated tool list",
        );
      }
      allowedTools = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      i += 1;
      continue;
    }
    if (arg === "--description") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError("roles edit: --description requires a value");
      }
      description = value;
      i += 1;
      continue;
    }
    if (arg === "--description-file") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError("roles edit: --description-file requires a path");
      }
      descriptionFile = value;
      i += 1;
      continue;
    }
    if (arg === "--add-skill") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError("roles edit: --add-skill requires name=FILE");
      }
      const eq = value.indexOf("=");
      if (eq <= 0 || eq === value.length - 1) {
        throw new CliUsageError(
          `roles edit: --add-skill expects name=FILE, got: ${value}`,
        );
      }
      addSkills.push({ name: value.slice(0, eq), file: value.slice(eq + 1) });
      i += 1;
      continue;
    }
    if (arg === "--remove-skill") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError("roles edit: --remove-skill requires a skill name");
      }
      removeSkills.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliUsageError(`roles edit: unknown flag: ${arg}`);
    }
    if (target !== undefined) {
      throw new CliUsageError(
        `roles edit: unexpected positional argument: ${arg}`,
      );
    }
    target = arg;
  }

  if (target === undefined) {
    throw new CliUsageError(
      "roles edit: missing target name or id (usage: `roles edit <name|id> [flags]`)",
    );
  }
  if (systemPromptFile !== undefined && systemPromptStdin) {
    throw new CliUsageError(
      "roles edit: --system-prompt-file and --system-prompt - both set; pick one source for the prompt",
    );
  }
  if (description !== undefined && descriptionFile !== undefined) {
    throw new CliUsageError(
      "roles edit: --description and --description-file both set; pick one source for the description",
    );
  }
  const hasAnyEdit =
    systemPromptFile !== undefined ||
    systemPromptStdin ||
    allowedTools !== undefined ||
    addSkills.length > 0 ||
    removeSkills.length > 0 ||
    description !== undefined ||
    descriptionFile !== undefined;
  if (!hasAnyEdit) {
    throw new CliUsageError(
      "roles edit: no edits provided (use --system-prompt-file, --system-prompt -, --allowed-tools, --add-skill, --remove-skill, --description, or --description-file)",
    );
  }

  const flags: EditFlags = {
    target,
    json,
    systemPromptStdin,
    addSkills,
    removeSkills,
    ...(systemPromptFile === undefined ? {} : { systemPromptFile }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(description === undefined ? {} : { description }),
    ...(descriptionFile === undefined ? {} : { descriptionFile }),
  };
  return flags;
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function buildPatch(
  ctx: CommandContext,
  flags: EditFlags,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};

  if (flags.systemPromptFile !== undefined) {
    patch["system_prompt"] = readFileSync(flags.systemPromptFile, "utf8");
  } else if (flags.systemPromptStdin) {
    patch["system_prompt"] = await readStdin(ctx.stdin);
  }

  if (flags.allowedTools !== undefined) {
    patch["allowed_tools"] = flags.allowedTools;
  }

  if (flags.description !== undefined) {
    patch["description"] = flags.description;
  } else if (flags.descriptionFile !== undefined) {
    patch["description"] = readFileSync(flags.descriptionFile, "utf8");
  }

  if (flags.addSkills.length > 0 || flags.removeSkills.length > 0) {
    const detail = await request<RoleDetailResponse>(ctx.env, {
      method: "GET",
      path: `/agent/roles/${encodeURIComponent(flags.target)}`,
    });
    const current: RoleSkill[] = [...detail.current_version.skills];
    const removeSet = new Set(flags.removeSkills);
    const filtered = current.filter((s) => !removeSet.has(s.name));
    const additions: RoleSkill[] = flags.addSkills.map(({ name, file }) => ({
      name,
      body: readFileSync(file, "utf8"),
    }));
    const additionNames = new Set(additions.map((s) => s.name));
    const merged: RoleSkill[] = [
      ...filtered.filter((s) => !additionNames.has(s.name)),
      ...additions,
    ];
    patch["skills"] = merged;
  }

  return patch;
}

export async function runEdit(
  ctx: CommandContext,
  rest: readonly string[],
): Promise<number> {
  const flags = parseFlags(rest);
  const patch = await buildPatch(ctx, flags);

  const result = await request<EditResponse>(ctx.env, {
    method: "PATCH",
    path: `/agent/roles/${encodeURIComponent(flags.target)}`,
    body: patch,
  });

  if (flags.json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const parts: string[] = [`edited ${flags.target}`];
  if (result.version !== undefined && result.version_id !== undefined) {
    parts.push(`-> v${result.version} (id: ${result.role_id}, version_id: ${result.version_id})`);
  } else {
    parts.push(`(id: ${result.role_id})`);
  }
  if (result.description !== undefined) {
    parts.push("[description updated]");
  }
  ctx.stdout.write(`${parts.join(" ")}\n`);
  return 0;
}
