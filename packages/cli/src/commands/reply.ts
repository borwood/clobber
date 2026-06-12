import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface ReplyResponse {
  readonly action: string;
  readonly replied_at: number;
}

const REPLY_USAGE = `usage: clobber reply <token> <text>

Answer a message a manager sent you, exactly once, with the single-use token
it handed you in the inbound <clobber type="message" … token>…</clobber> turn.

Positional:
  <token>  The reply capability from the message you received.
  <text>   Your reply body; lands as one turn on the manager that messaged you.

The token is spent after one use. To continue the thread, wait for the manager
to message you again (it gets a fresh token each time).

Example:
  clobber reply ab12cd34ef "yes — migration ran clean against staging first"

Skill: see worker:reply for when to reply vs. just absorb the note.`;

const ACTION_LABELS: Record<string, string> = {
  injected: "delivered (injected into manager's running session)",
  resumed: "delivered (manager woken via resume)",
  spawned: "delivered (manager woken via fresh spawn)",
  queued: "queued (manager offline — will land on next wake)",
};

export const replyCommand: Command = {
  name: "reply",
  summary: "Answer a manager's message once, using its single-use token.",
  usage: REPLY_USAGE,
  async run(ctx) {
    const [token, body, ...rest] = ctx.args;
    if (token === undefined || token.length === 0) {
      throw new CliUsageError("missing <token>");
    }
    if (body === undefined || body.length === 0) {
      throw new CliUsageError("missing <text>");
    }
    if (rest.length > 0) {
      throw new CliUsageError(`reply: unexpected extra arguments: ${rest.join(" ")}`);
    }
    const res = await request<ReplyResponse>(ctx.env, {
      method: "POST",
      path: "/agent/messages/replies",
      body: { token, body },
    });
    const label = ACTION_LABELS[res.action] ?? `replied (${res.action})`;
    ctx.stdout.write(`replied: ${label}\n`);
    return 0;
  },
};
