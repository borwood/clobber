import type { Command } from "../commands.ts";
import { request } from "../http.ts";

interface WhoAmI {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly role: { readonly id: string; readonly name: string };
  readonly started_at: number;
}

export const whoamiCommand: Command = {
  name: "whoami",
  summary: "Show this agent's session, workspace, and role.",
  async run(ctx) {
    const me = await request<WhoAmI>(ctx.env, { method: "GET", path: "/agent/me" });
    ctx.stdout.write(`${JSON.stringify(me, null, 2)}\n`);
    return 0;
  },
};
