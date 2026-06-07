import {
  RoleDetailResponseSchema,
  type PromptModuleRef,
} from "@clobber/shared";
import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface MutateResult {
  readonly role_id: string;
  readonly branch: string;
  readonly sha: string;
  readonly no_new_version: boolean;
}

async function fetchPromptModuleRefs(
  ctx: CommandContext,
  target: string,
): Promise<readonly PromptModuleRef[]> {
  const raw = await request<unknown>(ctx.env, {
    method: "GET",
    path: `/agent/roles/${encodeURIComponent(target)}`,
  });
  return RoleDetailResponseSchema.parse(raw).current_version.prompt_module_refs;
}

function renderList(refs: readonly PromptModuleRef[]): string {
  if (refs.length === 0) return "(no prompt-modules)\n";
  return `${refs
    .map((r) => `- ${r.name} — ${r.enabled ? "enabled" : "disabled"}`)
    .join("\n")}\n`;
}

export async function runPromptModules(
  ctx: CommandContext,
  rest: readonly string[],
): Promise<number> {
  const [target, action, name, ...extra] = rest;
  if (target === undefined) {
    throw new CliUsageError(
      "roles prompt-modules: missing role name or id (usage: `roles prompt-modules <name|id> [add|enable|disable <module>]`)",
    );
  }

  if (action === undefined) {
    ctx.stdout.write(renderList(await fetchPromptModuleRefs(ctx, target)));
    return 0;
  }

  if (action !== "add" && action !== "enable" && action !== "disable") {
    throw new CliUsageError(`roles prompt-modules: unknown action: ${action}`);
  }
  if (name === undefined) {
    throw new CliUsageError(`roles prompt-modules ${action}: missing module name`);
  }

  const flags = extra.filter((a) => a !== "--disabled");
  const disabled = extra.includes("--disabled");
  if (flags.length > 0) {
    throw new CliUsageError(
      `roles prompt-modules ${action}: unexpected arguments: ${flags.join(" ")}`,
    );
  }
  if (disabled && action !== "add") {
    throw new CliUsageError("roles prompt-modules: --disabled only applies to `add`");
  }

  let result: MutateResult;
  if (action === "add") {
    result = await request<MutateResult>(ctx.env, {
      method: "POST",
      path: `/agent/roles/${encodeURIComponent(target)}/prompt-modules`,
      body: { name, enabled: !disabled },
    });
  } else {
    const enabled = action === "enable";
    result = await request<MutateResult>(ctx.env, {
      method: "PATCH",
      path: `/agent/roles/${encodeURIComponent(target)}/prompt-modules/${encodeURIComponent(name)}`,
      body: { enabled },
    });
  }

  ctx.stdout.write(
    `roles prompt-modules ${action} ${name} -> ${result.sha.slice(0, 8)} (${target})\n`,
  );
  return 0;
}
