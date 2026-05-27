import {
  RoleDetailResponseSchema,
  type SeedRef,
} from "@clobber/shared";
import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface PatchResult {
  readonly role_id: string;
  readonly version_id?: string;
  readonly version?: number;
}

async function fetchSeedRefs(
  ctx: CommandContext,
  target: string,
): Promise<readonly SeedRef[]> {
  const raw = await request<unknown>(ctx.env, {
    method: "GET",
    path: `/agent/roles/${encodeURIComponent(target)}`,
  });
  return RoleDetailResponseSchema.parse(raw).current_version.seed_refs;
}

async function patchSeedRefs(
  ctx: CommandContext,
  target: string,
  seedRefs: readonly SeedRef[],
): Promise<PatchResult> {
  return request<PatchResult>(ctx.env, {
    method: "PATCH",
    path: `/agent/roles/${encodeURIComponent(target)}`,
    body: { seed_refs: seedRefs },
  });
}

function renderList(refs: readonly SeedRef[]): string {
  if (refs.length === 0) return "(no seeds)\n";
  return `${refs
    .map((r) => `- ${r.name} — ${r.enabled ? "enabled" : "disabled"}`)
    .join("\n")}\n`;
}

export async function runSeeds(
  ctx: CommandContext,
  rest: readonly string[],
): Promise<number> {
  const [target, action, name, ...extra] = rest;
  if (target === undefined) {
    throw new CliUsageError(
      "roles seeds: missing role name or id (usage: `roles seeds <name|id> [add|enable|disable <seed>]`)",
    );
  }

  if (action === undefined) {
    ctx.stdout.write(renderList(await fetchSeedRefs(ctx, target)));
    return 0;
  }

  if (action !== "add" && action !== "enable" && action !== "disable") {
    throw new CliUsageError(`roles seeds: unknown action: ${action}`);
  }
  if (name === undefined) {
    throw new CliUsageError(`roles seeds ${action}: missing seed name`);
  }

  const flags = extra.filter((a) => a !== "--disabled");
  const disabled = extra.includes("--disabled");
  if (flags.length > 0) {
    throw new CliUsageError(
      `roles seeds ${action}: unexpected arguments: ${flags.join(" ")}`,
    );
  }
  if (disabled && action !== "add") {
    throw new CliUsageError("roles seeds: --disabled only applies to `add`");
  }

  const refs = await fetchSeedRefs(ctx, target);

  let next: SeedRef[];
  if (action === "add") {
    if (refs.some((r) => r.name === name)) {
      throw new CliUsageError(`roles seeds add: seed already on role: ${name}`);
    }
    next = [...refs, { name, enabled: !disabled }];
  } else {
    if (!refs.some((r) => r.name === name)) {
      throw new CliUsageError(
        `roles seeds ${action}: seed is not ref'd on role: ${name}`,
      );
    }
    const enabled = action === "enable";
    next = refs.map((r) => (r.name === name ? { name: r.name, enabled } : r));
  }

  const result = await patchSeedRefs(ctx, target, next);
  ctx.stdout.write(
    `roles seeds ${action} ${name} -> v${result.version} (${target})\n`,
  );
  return 0;
}
