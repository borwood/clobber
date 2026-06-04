import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { resolveAgentTarget } from "../agent-target.ts";
import { CliUsageError } from "../usage-error.ts";

interface CycleResponse {
  readonly ok: true;
  readonly ack?: string;
  readonly cycled?: boolean;
}

const CYCLE_USAGE = `usage: clobber cycle [--agent <agent>] [--wake-program <name>] --prompt <text>
       clobber cycle --token <token>

Re-seat an agent into a FRESH session — same agent identity, new session-id,
clean context — seeded with a handoff brief, swapping its UI tab in place.
Self-cycle is the default: omit --agent to cycle yourself.

Cycle is gated by the tool-token interlock (#321). An un-tokened call no-ops and
drops a repercussion brief + one-time token into the TARGET's transcript (your
own, for a self-cycle); read it, wrap up per any handoff protocol in place, then
redeem with the printed \`clobber cycle --token <token>\`. The redemption kills
the old session first, then boots the fresh one — so it works even for a
ceiling-1 role like the manager.

The cycle operation always injects an orientation layer into the fresh session's
system prompt; --wake-program selects the opening move layered on top of it.
Defaults to "custom" so --prompt X → X-as-kick behavior is unchanged (#502).

v1: persistent agents only (the manager).

<agent> may be a label, a full session-id, or a session-id prefix (≥4 chars),
resolved against live sessions; an ambiguous match is rejected.

Flags:
  -a, --agent <agent>       Agent to cycle. Omit to cycle yourself (the default).
  -p, --prompt <text>       Handoff brief for your fresh self — the new session's
                            opening turn. Required when minting (no --token).
  -t, --token <token>       Redeem a one-time cycle token (proof you read the brief).
  -w, --wake-program <name> Opening move for the fresh session (default: custom).

Example:
  clobber cycle --prompt "HANDOFF: state is in office notes; resume the audit"
  clobber cycle --wake-program task --prompt "pick up from office notes"
  clobber cycle --agent deputy --prompt "wrap and cycle yourself"
  clobber cycle --token 3sQ...`;

function parseCycleArgs(args: readonly string[]): {
  agent?: string;
  prompt?: string;
  token?: string;
  wakeProgram?: string;
} {
  let agent: string | undefined;
  let prompt: string | undefined;
  let token: string | undefined;
  let wakeProgram: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--agent" || tok === "-a") {
      const value = args[i + 1];
      if (value === undefined) throw new CliUsageError("--agent requires a value");
      agent = value;
      i++;
    } else if (tok === "--prompt" || tok === "-p") {
      const value = args[i + 1];
      if (value === undefined) throw new CliUsageError("--prompt requires a value");
      prompt = value;
      i++;
    } else if (tok === "--token" || tok === "-t") {
      const value = args[i + 1];
      if (value === undefined) throw new CliUsageError("--token requires a value");
      token = value;
      i++;
    } else if (tok === "--wake-program" || tok === "-w") {
      const value = args[i + 1];
      if (value === undefined) throw new CliUsageError("--wake-program requires a value");
      wakeProgram = value;
      i++;
    } else if (tok.startsWith("-")) {
      throw new CliUsageError(`unknown flag: ${tok}`);
    } else {
      throw new CliUsageError(`unexpected argument: ${tok}`);
    }
  }
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(token === undefined ? {} : { token }),
    ...(wakeProgram === undefined ? {} : { wakeProgram }),
  };
}

export const cycleCommand: Command = {
  name: "cycle",
  summary: "Re-seat an agent into a fresh session (same identity, clean context).",
  usage: CYCLE_USAGE,
  async run(ctx) {
    const { agent, prompt, token, wakeProgram } = parseCycleArgs(ctx.args);

    // Redeem path: the saved --prompt travels with the token, so a redemption
    // takes only --token — mixing in mint flags is a usage error.
    if (token !== undefined) {
      if (agent !== undefined || prompt !== undefined || wakeProgram !== undefined) {
        throw new CliUsageError("--token redeems a saved cycle; do not combine it with --agent/--prompt/--wake-program");
      }
      const result = await request<CycleResponse>(ctx.env, {
        method: "POST",
        path: "/agent/cycle",
        body: { token },
      });
      ctx.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }

    // Mint path: a handoff brief is mandatory; the target defaults to self.
    if (prompt === undefined) {
      throw new CliUsageError("cycle: --prompt is required when minting (omit it only with --token)");
    }
    const targetSessionId =
      agent === undefined ? undefined : await resolveAgentTarget(ctx.env, agent, ["busy", "idle"]);
    const result = await request<CycleResponse>(ctx.env, {
      method: "POST",
      path: "/agent/cycle",
      body: {
        prompt,
        ...(targetSessionId === undefined ? {} : { target_session_id: targetSessionId }),
        ...(wakeProgram === undefined ? {} : { wake_program: wakeProgram }),
      },
    });
    ctx.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  },
};
