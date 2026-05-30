import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface MessageResponse {
  readonly message_id: string;
  readonly token: string;
  readonly sent_at: number;
}

const MESSAGE_USAGE = `usage: clobber message <agent-id> <text>

Send a note to a running agent in this workspace and hand it a single-use
token to reply with. Manager-only — a worker has no \`message\` verb.

Positional:
  <agent-id>  The recipient agent (see \`clobber agents list\`), same workspace.
  <text>      The message body.

The recipient's next turn carries the note as
<clobber type="message" from token>…</clobber>; the printed token is also
embedded there. The recipient may reply once via \`clobber reply <token>\`.

Example:
  clobber message 7f3a… "did you check the schema migration before debugging?"

Skill: see manager:message for when to nudge a worker vs. assign or kill.`;

export const messageCommand: Command = {
  name: "message",
  summary: "Send a note to a running agent and hand it a single-use reply token.",
  usage: MESSAGE_USAGE,
  async run(ctx) {
    const [agentId, body, ...rest] = ctx.args;
    if (agentId === undefined || agentId.length === 0) {
      throw new CliUsageError("missing <agent-id>");
    }
    if (body === undefined || body.length === 0) {
      throw new CliUsageError("missing <text>");
    }
    if (rest.length > 0) {
      throw new CliUsageError(`message: unexpected extra arguments: ${rest.join(" ")}`);
    }
    const res = await request<MessageResponse>(ctx.env, {
      method: "POST",
      path: "/agent/messages",
      body: { recipient_agent_id: agentId, body },
    });
    ctx.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  },
};
