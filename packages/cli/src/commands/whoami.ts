import type { Command } from "../commands.ts";
import { request } from "../http.ts";

interface WhoAmI {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly role: { readonly id: string; readonly name: string };
  readonly started_at: number;
}

const WHOAMI_USAGE = `usage: clobber whoami

Show this agent's session, workspace, and role as JSON. Useful for
sanity-checking which session token an agent is running under.

Flags:
  (no flags)

Example:
  clobber whoami

Skill: see manager:whoami / worker:whoami for usage patterns.`;

export const whoamiCommand: Command = {
  name: "whoami",
  summary: "Show this agent's session, workspace, and role.",
  usage: WHOAMI_USAGE,
  async run(ctx) {
    const me = await request<WhoAmI>(ctx.env, { method: "GET", path: "/agent/me" });
    ctx.stdout.write(`${JSON.stringify(me, null, 2)}\n`);
    return 0;
  },
};
