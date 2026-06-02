import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

const FINDING_USAGE = `usage: clobber finding <summary>

Append a triage-drop observation for the current agent. Repeatable: each call
writes one kind=finding row — there is no once-per-session cap (unlike
\`clobber report\`). The row inherits full provenance (commit, role_version_id,
transcript_anchor) at the append sink.

Positional:
  <summary>   One-line observation text.

Example:
  clobber finding "disk-usage spike correlates with prompt-module seeding"

Skill: see manager:reports for triage strategy.`;

export const findingCommand: Command = {
  name: "finding",
  summary: "Append a triage-drop finding for the current agent (append-many, fire-and-forget).",
  usage: FINDING_USAGE,
  async run(ctx) {
    const [summary] = ctx.args;
    if (summary === undefined || summary.length === 0) {
      throw new CliUsageError("missing summary");
    }
    if (ctx.args.length > 1) {
      throw new CliUsageError(
        `unexpected extra arguments: ${ctx.args.slice(1).join(" ")} — wrap multi-word summary in quotes`,
      );
    }
    await request<{ ok: true }>(ctx.env, {
      method: "POST",
      path: "/agent/finding",
      body: { summary },
    });
    return 0;
  },
};
