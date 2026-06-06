import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  RoleDetailResponseSchema,
  type RoleSkill,
} from "@clobber/shared";
import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";
import { parseFlags } from "./roles-edit-flags.ts";

interface EditResponse {
  readonly role_id: string;
  // #414 — a content edit advances the git pin (no version row). A
  // description-only edit is metadata: it returns just role_id + description.
  readonly branch?: string;
  readonly sha?: string;
  readonly no_new_version?: boolean;
  readonly description?: string;
}

// Read a skill from a directory (#450, #517). The dir must contain SKILL.md;
// all other files (including those in subdirectories) become companion entries
// in `skill.files` keyed by their path relative to the skill dir.
function readSkillFromDir(name: string, dir: string): RoleSkill {
  const skillMdPath = join(dir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new CliUsageError(
      `roles edit: --add-skill directory must contain SKILL.md, not found in: ${dir}`,
    );
  }
  const body = readFileSync(skillMdPath, "utf8");
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const rel = relative(dir, abs);
        if (rel !== "SKILL.md") files[rel] = readFileSync(abs, "utf8");
      }
    }
  };
  walk(dir);
  const skill: RoleSkill = { name, body };
  if (Object.keys(files).length > 0) skill.files = files;
  return skill;
}

function readSkillEntry(name: string, path: string): RoleSkill {
  if (statSync(path).isDirectory()) return readSkillFromDir(name, path);
  return { name, body: readFileSync(path, "utf8") };
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
  flags: ReturnType<typeof parseFlags>,
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

  if (flags.triggersJson !== undefined || flags.triggersFile !== undefined) {
    const raw =
      flags.triggersJson !== undefined
        ? flags.triggersJson
        : readFileSync(flags.triggersFile!, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new CliUsageError(
        `roles edit: --triggers value is not valid JSON: ${(e as Error).message}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new CliUsageError(
        "roles edit: --triggers must be a JSON array of trigger objects",
      );
    }
    patch["triggers"] = parsed;
  }

  if (flags.addSkills.length > 0 || flags.removeSkills.length > 0) {
    const detailRaw = await request<unknown>(ctx.env, {
      method: "GET",
      path: `/agent/roles/${encodeURIComponent(flags.target)}`,
    });
    const detail = RoleDetailResponseSchema.parse(detailRaw);
    const current: RoleSkill[] = [...detail.current_version.skills];
    const removeSet = new Set(flags.removeSkills);
    const filtered = current.filter((s) => !removeSet.has(s.name));
    const additions = flags.addSkills.map(({ name, file }) => readSkillEntry(name, file));
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
  if (result.sha !== undefined && result.branch !== undefined) {
    parts.push(`-> ${result.sha.slice(0, 8)} (branch ${result.branch})`);
  } else {
    parts.push(`(id: ${result.role_id})`);
  }
  if (result.description !== undefined) {
    parts.push("[description updated]");
  }
  ctx.stdout.write(`${parts.join(" ")}\n`);
  return 0;
}
