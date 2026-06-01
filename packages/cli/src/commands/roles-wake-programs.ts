import { readFileSync } from "node:fs";
import {
  IDLE_WAKE_PROGRAM,
  IDLE_WAKE_PROGRAM_NAME,
  RoleDetailResponseSchema,
  type WakeProgram,
} from "@clobber/shared";
import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface PatchResult {
  readonly role_id: string;
  // #414 — wake-program edits advance the git pin (no version row).
  readonly branch: string;
  readonly sha: string;
  readonly no_new_version: boolean;
}

// Parsed authoring inputs. `system`/`user` are present only when their flag was
// supplied, so `edit` can distinguish "leave as-is" from "set to this".
interface WakeFlags {
  readonly system?: string;
  readonly user?: string | null;
}

function parseWakeFlags(verb: string, args: readonly string[]): WakeFlags {
  let system: string | undefined;
  let user: string | null | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--system") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError(`roles wake-programs ${verb}: --system requires text`);
      }
      system = value;
      i += 1;
      continue;
    }
    if (arg === "--system-file") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError(`roles wake-programs ${verb}: --system-file requires a path`);
      }
      system = readFileSync(value, "utf8");
      i += 1;
      continue;
    }
    if (arg === "--user") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError(`roles wake-programs ${verb}: --user requires text`);
      }
      user = value;
      i += 1;
      continue;
    }
    if (arg === "--no-user") {
      user = null;
      continue;
    }
    throw new CliUsageError(`roles wake-programs ${verb}: unknown argument: ${arg}`);
  }
  if (system !== undefined && user !== undefined) return { system, user };
  if (system !== undefined) return { system };
  if (user !== undefined) return { user };
  return {};
}

async function fetchPrograms(
  ctx: CommandContext,
  target: string,
): Promise<readonly WakeProgram[]> {
  const raw = await request<unknown>(ctx.env, {
    method: "GET",
    path: `/agent/roles/${encodeURIComponent(target)}`,
  });
  return RoleDetailResponseSchema.parse(raw).current_version.wake_programs;
}

async function patchPrograms(
  ctx: CommandContext,
  target: string,
  programs: readonly WakeProgram[],
): Promise<PatchResult> {
  return request<PatchResult>(ctx.env, {
    method: "PATCH",
    path: `/agent/roles/${encodeURIComponent(target)}`,
    body: { wake_programs: programs },
  });
}

function renderList(programs: readonly WakeProgram[]): string {
  const all = [IDLE_WAKE_PROGRAM, ...programs];
  return `${all
    .map((p) => {
      const builtIn = p.name === IDLE_WAKE_PROGRAM_NAME ? " (built-in)" : "";
      return `- ${p.name}${builtIn} — kick: ${p.user === null ? "(none)" : "yes"}`;
    })
    .join("\n")}\n`;
}

function renderShow(p: WakeProgram): string {
  return [
    `# wake-program: ${p.name}`,
    "",
    "## system (layer C addon)",
    p.system.length === 0 ? "(empty)" : p.system.trimEnd(),
    "",
    "## user (opening kick)",
    p.user === null ? "(none — no kick)" : p.user,
    "",
  ].join("\n");
}

function reserved(verb: string, name: string): void {
  if (name === IDLE_WAKE_PROGRAM_NAME) {
    throw new CliUsageError(
      `roles wake-programs ${verb}: \`idle\` is the reserved built-in and cannot be authored`,
    );
  }
}

export async function runWakePrograms(
  ctx: CommandContext,
  rest: readonly string[],
): Promise<number> {
  const [target, action, name, ...extra] = rest;
  if (target === undefined) {
    throw new CliUsageError(
      "roles wake-programs: missing role name or id (usage: `roles wake-programs <name|id> [show|add|edit|remove <name> ...]`)",
    );
  }

  if (action === undefined) {
    ctx.stdout.write(renderList(await fetchPrograms(ctx, target)));
    return 0;
  }
  if (action !== "show" && action !== "add" && action !== "edit" && action !== "remove") {
    throw new CliUsageError(`roles wake-programs: unknown action: ${action}`);
  }
  if (name === undefined) {
    throw new CliUsageError(`roles wake-programs ${action}: missing program name`);
  }

  if (action === "show") {
    if (extra.length > 0) {
      throw new CliUsageError(
        `roles wake-programs show: unexpected arguments: ${extra.join(" ")}`,
      );
    }
    if (name === IDLE_WAKE_PROGRAM_NAME) {
      ctx.stdout.write(renderShow(IDLE_WAKE_PROGRAM));
      return 0;
    }
    const program = (await fetchPrograms(ctx, target)).find((p) => p.name === name);
    if (program === undefined) {
      throw new CliUsageError(`roles wake-programs show: no program named: ${name}`);
    }
    ctx.stdout.write(renderShow(program));
    return 0;
  }

  reserved(action, name);
  const programs = await fetchPrograms(ctx, target);

  let next: WakeProgram[];
  if (action === "remove") {
    if (extra.length > 0) {
      throw new CliUsageError(
        `roles wake-programs remove: unexpected arguments: ${extra.join(" ")}`,
      );
    }
    if (!programs.some((p) => p.name === name)) {
      throw new CliUsageError(`roles wake-programs remove: no program named: ${name}`);
    }
    next = programs.filter((p) => p.name !== name);
  } else if (action === "add") {
    const flags = parseWakeFlags("add", extra);
    if (programs.some((p) => p.name === name)) {
      throw new CliUsageError(`roles wake-programs add: program already exists: ${name}`);
    }
    if (flags.system === undefined) {
      throw new CliUsageError(
        "roles wake-programs add: --system or --system-file is required",
      );
    }
    if (flags.user === undefined) {
      throw new CliUsageError(
        "roles wake-programs add: a kick is required — pass --user TEXT or --no-user",
      );
    }
    next = [...programs, { name, system: flags.system, user: flags.user }];
  } else {
    const flags = parseWakeFlags("edit", extra);
    const current = programs.find((p) => p.name === name);
    if (current === undefined) {
      throw new CliUsageError(`roles wake-programs edit: no program named: ${name}`);
    }
    if (flags.system === undefined && flags.user === undefined) {
      throw new CliUsageError(
        "roles wake-programs edit: nothing to change — pass --system/--system-file and/or --user/--no-user",
      );
    }
    const merged: WakeProgram = {
      name,
      system: flags.system === undefined ? current.system : flags.system,
      user: flags.user === undefined ? current.user : flags.user,
    };
    next = programs.map((p) => (p.name === name ? merged : p));
  }

  const result = await patchPrograms(ctx, target, next);
  ctx.stdout.write(
    `roles wake-programs ${action} ${name} -> ${result.sha.slice(0, 8)} (${target})\n`,
  );
  return 0;
}
