import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface NotificationsListResponse {
  readonly notifications: readonly {
    readonly id: string;
    readonly type: string;
    readonly priority: string;
    readonly state: string;
    readonly payload: { readonly body: string };
    readonly created_at: number;
  }[];
}

const NOTIFY_USAGE = `usage: clobber notify list
       clobber notify ack <id>

Manage the notification inbox. When called from an agent session, operates on
that agent's own inbox (recipient inferred from the session token). When called
from a user context, operates on the user's inbox.

Subcommands:
  list        Show un-acked notifications (state: pending or delivered).
  ack <id>    Acknowledge a notification by ID (idempotent).

Examples:
  clobber notify list
  clobber notify ack 3fa85f64-…`;

export const notifyCommand: Command = {
  name: "notify",
  summary: "List or acknowledge user notifications.",
  usage: NOTIFY_USAGE,
  async run(ctx) {
    const [sub, id, ...rest] = ctx.args;
    const isAgent = ctx.env.agentId !== undefined;
    if (sub === "list") {
      if (rest.length > 0) {
        throw new CliUsageError(`notify list: unexpected arguments: ${rest.join(" ")}`);
      }
      const listPath = isAgent ? "/agent/notifications" : "/notifications?recipient=user";
      const res = await request<NotificationsListResponse>(ctx.env, {
        method: "GET",
        path: listPath,
      });
      if (res.notifications.length === 0) {
        ctx.stdout.write("No unacknowledged notifications.\n");
        return 0;
      }
      for (const n of res.notifications) {
        const ts = new Date(n.created_at).toISOString();
        ctx.stdout.write(`[${ts}] (${n.id}) [${n.type}/${n.priority}] ${n.payload.body}\n`);
      }
      return 0;
    }
    if (sub === "ack") {
      if (id === undefined || id.length === 0) {
        throw new CliUsageError("notify ack: missing <id>");
      }
      if (rest.length > 0) {
        throw new CliUsageError(`notify ack: unexpected arguments: ${rest.join(" ")}`);
      }
      const ackPath = isAgent ? `/agent/notifications/${id}/ack` : `/notifications/${id}/ack`;
      await request<{ ok: boolean }>(ctx.env, {
        method: "POST",
        path: ackPath,
        body: {},
      });
      ctx.stdout.write(`Acknowledged ${id}\n`);
      return 0;
    }
    throw new CliUsageError(sub === undefined ? "notify: missing subcommand" : `notify: unknown subcommand '${sub}'`);
  },
};
