import { CliUsageError } from "../usage-error.ts";

export interface EditFlags {
  readonly target: string;
  readonly json: boolean;
  readonly systemPromptFile?: string;
  readonly systemPromptStdin: boolean;
  readonly allowedTools?: readonly string[];
  readonly addSkills: ReadonlyArray<{ readonly name: string; readonly file: string }>;
  readonly removeSkills: readonly string[];
  readonly description?: string;
  readonly descriptionFile?: string;
  readonly triggersJson?: string;
  readonly triggersFile?: string;
}

export function parseFlags(args: readonly string[]): EditFlags {
  let target: string | undefined;
  let json = false;
  let systemPromptFile: string | undefined;
  let systemPromptStdin = false;
  let allowedTools: readonly string[] | undefined;
  const addSkills: Array<{ name: string; file: string }> = [];
  const removeSkills: string[] = [];
  let description: string | undefined;
  let descriptionFile: string | undefined;
  let triggersJson: string | undefined;
  let triggersFile: string | undefined;

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
    if (arg === "--triggers") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError(
          "roles edit: --triggers requires a JSON array (e.g. '[{\"kind\":\"cron\",\"expr\":\"0 9 * * *\"}]')",
        );
      }
      triggersJson = value;
      i += 1;
      continue;
    }
    if (arg === "--triggers-file") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError("roles edit: --triggers-file requires a path");
      }
      triggersFile = value;
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
  if (triggersJson !== undefined && triggersFile !== undefined) {
    throw new CliUsageError(
      "roles edit: --triggers and --triggers-file both set; pick one source for the triggers",
    );
  }
  const hasAnyEdit =
    systemPromptFile !== undefined ||
    systemPromptStdin ||
    allowedTools !== undefined ||
    addSkills.length > 0 ||
    removeSkills.length > 0 ||
    description !== undefined ||
    descriptionFile !== undefined ||
    triggersJson !== undefined ||
    triggersFile !== undefined;
  if (!hasAnyEdit) {
    throw new CliUsageError(
      "roles edit: no edits provided (use --system-prompt-file, --system-prompt -, --allowed-tools, --add-skill, --remove-skill, --description, --description-file, --triggers, or --triggers-file)",
    );
  }

  return {
    target,
    json,
    systemPromptStdin,
    addSkills,
    removeSkills,
    ...(systemPromptFile === undefined ? {} : { systemPromptFile }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(description === undefined ? {} : { description }),
    ...(descriptionFile === undefined ? {} : { descriptionFile }),
    ...(triggersJson === undefined ? {} : { triggersJson }),
    ...(triggersFile === undefined ? {} : { triggersFile }),
  };
}
