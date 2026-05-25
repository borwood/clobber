import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface ResumeResponse {
  readonly session_id: string;
  readonly pid: number;
}

const RESUME_USAGE = `usage: clobber resume <session-id> [--prompt <text>]

Bring an ended agent session back in the current workspace. Respawns the
underlying runtime against the session's existing conversation thread
(claude --resume) and re-registers it, preserving the role version pinned to
the original session. Re-checks the workspace role ceiling first.

Flags:
  -p, --prompt <text>   Follow-up directive for the revived agent (e.g. "the
                        test you wrote was wrong, try again"). Omit to resume
                        the conversation cleanly.

Example:
  clobber resume 0b2f4e1a-... --prompt "CI is green now, open the PR"

Skill: see manager:resume (parallels manager:kill) for when to revive a worker
vs. spawn a fresh one.`;

function parseResumeArgs(args: readonly string[]): {
  sessionId: string;
  prompt?: string;
} {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--prompt" || tok === "-p") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliUsageError("--prompt requires a value");
      }
      prompt = value;
      i++;
    } else if (tok.startsWith("-")) {
      throw new CliUsageError(`unknown flag: ${tok}`);
    } else if (sessionId === undefined) {
      sessionId = tok;
    } else {
      throw new CliUsageError(`unexpected argument: ${tok}`);
    }
  }
  if (sessionId === undefined) {
    throw new CliUsageError("resume: missing session id (usage: `resume <session-id>`)");
  }
  return { sessionId, ...(prompt === undefined ? {} : { prompt }) };
}

export const resumeCommand: Command = {
  name: "resume",
  summary: "Bring an ended agent session back in the current workspace.",
  usage: RESUME_USAGE,
  async run(ctx) {
    const { sessionId, prompt } = parseResumeArgs(ctx.args);
    const result = await request<ResumeResponse>(ctx.env, {
      method: "POST",
      path: `/agent/sessions/${encodeURIComponent(sessionId)}/resume`,
      body: prompt === undefined ? {} : { prompt },
    });
    ctx.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  },
};
