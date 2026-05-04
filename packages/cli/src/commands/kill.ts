import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface KillResponse {
  readonly ok: true;
}

export const killCommand: Command = {
  name: "kill",
  summary: "Terminate a live agent session in the current workspace.",
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
