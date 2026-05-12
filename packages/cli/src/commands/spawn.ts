import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { BriefingFile } from "@clobber/shared";
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
  const briefingPairs: { name: string; path: string }[] = [];

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

  return {
    role,
    prompt,
    label,
    ...(briefingDir === undefined ? {} : { briefingDir }),
    briefingPairs,
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

const SPAWN_USAGE = `usage: clobber spawn <role> --prompt <text> --label <slug> [--briefing-dir <path>] [--briefing <name:path>...]

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

Briefing files land at .clobber/agents/<agent-id>/desk/, which the worker
sees via $CLOBBER_DESK_DIR. The WorkerBee role's first action is to read
that directory; in particular, a seed-todos.json file there becomes the
worker's TodoWrite phase plan.

Example:
  clobber spawn worker --prompt "investigate flaky test in agents.test.ts" \\
                       --label fix-flaky-test
  clobber spawn worker-bee --prompt "ship #82" --label issue-82 \\
                           --briefing-dir /tmp/issue-82-packet

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
    const result = await request<SpawnResponse>(ctx.env, {
      method: "POST",
      path: "/agent/spawn",
      body,
    });
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  },
};
