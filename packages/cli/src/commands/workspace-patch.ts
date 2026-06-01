import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface AgentMe {
  readonly workspace_id: string;
}

interface WorkspaceConfig {
  readonly manager_skill_policy: {
    readonly allow_self_grant: boolean;
    readonly allowed_skills: readonly string[];
  };
}

interface PatchFlags {
  readonly allowSkills: readonly string[];
  readonly disallowSkills: readonly string[];
  readonly allowSelfGrant: boolean | undefined;
  readonly jsonBody: Record<string, unknown> | undefined;
  readonly outputJson: boolean;
}

const PATCH_FLAGS_HINT =
  "use --allow-skill, --disallow-skill, --allow-self-grant, or --json <body>";

function parsePatchFlags(args: readonly string[]): PatchFlags {
  const allowSkills: string[] = [];
  const disallowSkills: string[] = [];
  let allowSelfGrant: boolean | undefined;
  let jsonBody: Record<string, unknown> | undefined;
  let outputJson = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--allow-skill") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new CliUsageError("workspace patch: --allow-skill requires a skill name");
      }
      allowSkills.push(v);
      i += 1;
      continue;
    }
    if (arg === "--disallow-skill") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new CliUsageError("workspace patch: --disallow-skill requires a skill name");
      }
      disallowSkills.push(v);
      i += 1;
      continue;
    }
    if (arg === "--allow-self-grant") {
      const v = args[i + 1];
      if (v === "true") {
        allowSelfGrant = true;
      } else if (v === "false") {
        allowSelfGrant = false;
      } else {
        throw new CliUsageError('workspace patch: --allow-self-grant requires "true" or "false"');
      }
      i += 1;
      continue;
    }
    if (arg === "--json") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(next);
        } catch {
          throw new CliUsageError(`workspace patch: --json body is not valid JSON: ${next}`);
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new CliUsageError("workspace patch: --json body must be a JSON object");
        }
        jsonBody = parsed as Record<string, unknown>;
        i += 1;
      }
      outputJson = true;
      continue;
    }
    throw new CliUsageError(`workspace patch: unknown argument: ${arg}`);
  }

  const hasInput =
    allowSkills.length > 0 ||
    disallowSkills.length > 0 ||
    allowSelfGrant !== undefined ||
    jsonBody !== undefined;
  if (!hasInput) {
    throw new CliUsageError(`workspace patch: no fields to patch — ${PATCH_FLAGS_HINT}`);
  }

  return { allowSkills, disallowSkills, allowSelfGrant, jsonBody, outputJson };
}

export async function runPatch(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const flags = parsePatchFlags(rest);

  const me = await request<AgentMe>(ctx.env, { method: "GET", path: "/agent/me" });
  const workspaceId = me.workspace_id;

  const body: Record<string, unknown> = { ...(flags.jsonBody ?? {}) };

  const needsSkillPolicy =
    flags.allowSkills.length > 0 ||
    flags.disallowSkills.length > 0 ||
    flags.allowSelfGrant !== undefined;

  if (needsSkillPolicy) {
    const ws = await request<WorkspaceConfig>(ctx.env, {
      method: "GET",
      path: `/workspaces/${workspaceId}`,
    });
    const current = ws.manager_skill_policy;
    let skills = [...current.allowed_skills];
    for (const s of flags.allowSkills) {
      if (!skills.includes(s)) skills.push(s);
    }
    for (const s of flags.disallowSkills) {
      skills = skills.filter((x) => x !== s);
    }
    body["manager_skill_policy"] = {
      allow_self_grant: flags.allowSelfGrant ?? current.allow_self_grant,
      allowed_skills: skills,
    };
  }

  const result = await request<unknown>(ctx.env, {
    method: "PATCH",
    path: `/workspaces/${workspaceId}`,
    body,
  });

  if (flags.outputJson) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write("workspace patched\n");
  return 0;
}
