import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { EffortLevelSchema, MODEL_ALIASES, ModelSchema, type BriefingFile, type CliScope, type EffortLevel, type Model } from "@clobber/shared";
import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface SpawnResponse {
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
}

interface ParsedArgs {
  readonly role: string;
  readonly prompt: string;
  readonly label: string;
  readonly briefingDir?: string;
  readonly briefingPairs: readonly { readonly name: string; readonly path: string }[];
  readonly effort?: EffortLevel;
  readonly model?: Model;
  readonly wakeProgram?: string;
  readonly scopeOverride?: CliScope;
}

function takeValue(
  args: readonly string[],
  i: number,
  flag: string,
): string {
  const value = args[i + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
}

function parseBriefingPair(raw: string): { name: string; path: string } {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new CliUsageError(
      `--briefing expects <name>:<path>, got: ${raw}`,
    );
  }
  return { name: raw.slice(0, idx), path: raw.slice(idx + 1) };
}

export function parseSpawnArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let prompt: string | undefined;
  let label: string | undefined;
  let briefingDir: string | undefined;
  let effort: EffortLevel | undefined;
  let model: Model | undefined;
  let wakeProgram: string | undefined;
  const briefingPairs: { name: string; path: string }[] = [];
  const scopeAllowTokens: string[] = [];
  const scopeDenyTokens: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--prompt" || tok === "-p") {
      prompt = takeValue(args, i, "--prompt");
      i++;
    } else if (tok === "--label" || tok === "-l") {
      label = takeValue(args, i, "--label");
      i++;
    } else if (tok === "--briefing-dir") {
      briefingDir = takeValue(args, i, "--briefing-dir");
      i++;
    } else if (tok === "--briefing") {
      briefingPairs.push(parseBriefingPair(takeValue(args, i, "--briefing")));
      i++;
    } else if (tok === "--effort") {
      const raw = takeValue(args, i, "--effort");
      const parsed = EffortLevelSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CliUsageError(
          `--effort must be one of low|medium|high|xhigh|max, got: ${raw}`,
        );
      }
      effort = parsed.data;
      i++;
    } else if (tok === "--model") {
      const raw = takeValue(args, i, "--model");
      const parsed = ModelSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CliUsageError(
          `--model must be one of ${MODEL_ALIASES.join("|")}, or a full claude-* model name, got: ${raw}`,
        );
      }
      model = parsed.data;
      i++;
    } else if (tok === "--wake-program") {
      wakeProgram = takeValue(args, i, "--wake-program");
      i++;
    } else if (tok === "--scope") {
      scopeAllowTokens.push(takeValue(args, i, "--scope"));
      i++;
    } else if (tok === "--deny") {
      const raw = takeValue(args, i, "--deny");
      // Normalise: prepend '!' if the caller omitted it (shell-friendly).
      scopeDenyTokens.push(raw.startsWith("!") ? raw : `!${raw}`);
      i++;
    } else if (tok.startsWith("--") || (tok.startsWith("-") && tok.length > 1)) {
      throw new CliUsageError(`unknown flag: ${tok}`);
    } else {
      positionals.push(tok);
    }
  }

  const role = positionals[0];
  if (role === undefined) {
    throw new CliUsageError("missing role positional argument");
  }
  if (positionals.length > 1) {
    throw new CliUsageError(`unexpected extra arguments: ${positionals.slice(1).join(" ")}`);
  }
  if (prompt === undefined) {
    throw new CliUsageError("--prompt is required");
  }
  if (label === undefined) {
    throw new CliUsageError(
      "--label is required (e.g. --label fix-flaky-test) — names a worker by what it's doing so the workspace board stays legible",
    );
  }

  const scopeOverride: CliScope | undefined =
    scopeAllowTokens.length > 0 || scopeDenyTokens.length > 0
      ? { allow: scopeAllowTokens.length > 0 ? scopeAllowTokens : ["*"], deny: scopeDenyTokens }
      : undefined;

  return {
    role,
    prompt,
    label,
    ...(briefingDir === undefined ? {} : { briefingDir }),
    briefingPairs,
    ...(effort === undefined ? {} : { effort }),
    ...(model === undefined ? {} : { model }),
    ...(wakeProgram === undefined ? {} : { wakeProgram }),
    ...(scopeOverride === undefined ? {} : { scopeOverride }),
  };
}

export function collectBriefingFiles(
  parsed: Pick<ParsedArgs, "briefingDir" | "briefingPairs">,
): readonly BriefingFile[] {
  const files: BriefingFile[] = [];
  if (parsed.briefingDir !== undefined) {
    const root = parsed.briefingDir;
    const stat = statSync(root);
    if (!stat.isDirectory()) {
      throw new CliUsageError(`--briefing-dir is not a directory: ${root}`);
    }
    walkDir(root, root, files);
  }
  for (const pair of parsed.briefingPairs) {
    files.push({ name: pair.name, content: readFileSync(pair.path, "utf8") });
  }
  return files;
}

function walkDir(root: string, dir: string, out: BriefingFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(root, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = relative(root, abs).split(/[\\/]/).join("/");
    out.push({ name, content: readFileSync(abs, "utf8") });
  }
}

const SPAWN_USAGE = `usage: clobber spawn <role> --prompt <text> --label <slug> [--briefing-dir <path>] [--briefing <name:path>...] [--effort <level>] [--model <model>] [--wake-program <name>] [--scope <token>...] [--deny <verb>...]

Spawn a worker agent into the current workspace. The role must already
exist in this workspace (see \`clobber roles list\`). Prints the new
agent_id, session_id, and pid as JSON.

Flags:
  -p, --prompt <text>            Initial user prompt for the worker (required).
  -l, --label <slug>             Short slug naming what the worker is doing
                                 (required, e.g. fix-flaky-test) so the
                                 workspace board stays legible.
      --briefing-dir <path>      Copy every file under <path> onto the
                                 worker's desk before its first turn. The
                                 directory's relative layout is preserved.
      --briefing <name:path>     Drop a single file at <name> on the worker's
                                 desk, with content read from <path>. May be
                                 repeated. Combinable with --briefing-dir.
      --effort <level>           Reasoning depth: low|medium|high|xhigh|max.
                                 Overrides the role's default for this spawn.
                                 Omit to use the role default.
      --model <model>            Model alias (default|best|opus|sonnet|haiku|
                                 opus[1m]|sonnet[1m]|opusplan) or a full
                                 claude-* API name (e.g. claude-opus-4-8).
                                 Overrides the role's default for this spawn.
                                 Omit to use the role default (or claude's
                                 default if neither is set).
      --wake-program <name>      The opening move: composes that program's
                                 layer-C system addon and fires its kick. Use
                                 \`task\` for a worker that should read its desk
                                 and start the SDLC; \`idle\` to boot oriented
                                 and wait. Omit for the legacy prompt-as-kick.
      --scope <token>            Add an allow token to the agent's per-spawn
                                 scope override (e.g. tag:read, spawn, role.*).
                                 May be repeated. Omit for the role default (all
                                 capabilities the role + workspace grant).
      --deny <verb>              Add a deny to the agent's per-spawn scope
                                 override (e.g. roles.commit). The leading '!'
                                 is added automatically. May be repeated. At
                                 least one --scope is assumed '*' when only
                                 --deny is given.

Briefing files land at .clobber/agents/<agent-id>/desk/, which the worker
sees via $CLOBBER_DESK_DIR. The worker role's first action is to read that
directory; in particular, a boot-tasks.json file there becomes the worker's
task-tool phase plan.

Example:
  clobber spawn worker --prompt "ship #82" --label issue-82 \\
                       --briefing-dir /tmp/issue-82-packet

  clobber spawn worker --prompt "audit roles" --label role-audit \\
                       --scope tag:read --deny roles.commit

Skill: see manager:spawn for when to spawn vs. continue an existing session,
and manager:assignment for building a briefing packet from a GitHub issue.`;

export const spawnCommand: Command = {
  name: "spawn",
  summary: "Spawn a worker agent into the current workspace.",
  usage: SPAWN_USAGE,
  async run(ctx) {
    const parsed = parseSpawnArgs(ctx.args);
    const files = collectBriefingFiles(parsed);
    const body: Record<string, unknown> = {
      role: parsed.role,
      prompt: parsed.prompt,
      label: parsed.label,
    };
    if (files.length > 0) {
      body["briefing"] = { files };
    }
    if (parsed.effort !== undefined) {
      body["effort"] = parsed.effort;
    }
    if (parsed.model !== undefined) {
      body["model"] = parsed.model;
    }
    if (parsed.wakeProgram !== undefined) {
      body["wake_program"] = parsed.wakeProgram;
    }
    if (parsed.scopeOverride !== undefined) {
      body["scope_override"] = parsed.scopeOverride;
    }
    const result = await request<SpawnResponse>(ctx.env, {
      method: "POST",
      path: "/agent/spawn",
      body,
    });
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  },
};
