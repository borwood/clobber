import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface KillResponse {
  readonly ok: true;
}

const KILL_USAGE = `usage: clobber kill <session-id>

Terminate a live agent session in the current workspace. Sends SIGTERM
to the underlying claude process and reaps the session.

Flags:
  (no flags)

Example:
  clobber kill 0b2f4e1a-...

Skill: see manager:kill for when to kill vs. interrupt vs. let an agent finish.`;

export const killCommand: Command = {
  name: "kill",
  summary: "Terminate a live agent session in the current workspace.",
  usage: KILL_USAGE,
  async run(ctx) {
    const [sessionId, ...rest] = ctx.args;
    if (sessionId === undefined) {
      throw new CliUsageError("kill: missing session id (usage: `kill <session-id>`)");
    }
    if (rest.length > 0) {
      throw new CliUsageError(`kill: unexpected arguments: ${rest.join(" ")}`);
    }
    const result = await request<KillResponse>(ctx.env, {
      method: "POST",
      path: `/agent/sessions/${encodeURIComponent(sessionId)}/kill`,
    });
    ctx.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  },
};
