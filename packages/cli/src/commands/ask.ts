import { AgentAskResponseSchema, type AgentAskResponse } from "@clobber/shared";
import type { Command } from "../commands.ts";
import type { CliEnv } from "../env.ts";
import { request, CliHttpError } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface ParsedArgs {
  readonly question: string;
  readonly options: readonly string[];
}

interface PollRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}

// Thrown when the server cannot be reached at all within the retry budget. A
// blocking ask never expires while waiting for a human (#241) — this is only the
// "the server is gone" case, surfaced to the agent as a trustable notice.
class AskUndeliverableError extends Error {}

function parseArgs(args: readonly string[]): ParsedArgs {
  const question = args[0];
  if (question === undefined || question.length === 0) {
    throw new CliUsageError("missing question");
  }
  const options: string[] = [];
  let i = 1;
  while (i < args.length) {
    const flag = args[i];
    if (flag !== "--option") {
      throw new CliUsageError(`unexpected argument: ${flag}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.length === 0) {
      throw new CliUsageError("missing value for --option");
    }
    options.push(value);
    i += 2;
  }
  return { question, options };
}

const ASK_USAGE = `usage: clobber ask <question> [--option <value>]...

Ask the human a question and block until they answer. A blocking ask never
expires — it waits as long as it takes. Prints the answer to stdout on success
(exit 0). If the ask genuinely can't be delivered (the server is gone) or is
closed (session ended / superseded), prints a clear notice to stdout and STILL
exits 0 — a delivery hiccup is never reported as a broken tool.

Flags:
  --option <value>   Offer the human a predefined choice (repeatable).
                     The web ask widget renders these as buttons; the
                     human can still type a custom answer.

Examples:
  ANSWER=$(clobber ask "ship the migration?")
  clobber ask "merge or rebase?" --option merge --option rebase

Skill: see manager:ask / worker:ask for when to ask vs. just decide.`;

const NO_ANSWER_CANCELLED =
  "clobber ask: no answer available — the ask was closed (the session ended or a " +
  "newer ask replaced it). The ask channel is healthy; this is not a tool failure, " +
  "and your question was not lost. Proceed using your best judgment.\n";

const NO_ANSWER_UNDELIVERABLE =
  "clobber ask: no answer available — could not reach the clobber server after " +
  "retrying, so the ask could not be delivered. This is not a tool failure on your " +
  "side; the ask channel itself is fine and the question may remain pending. " +
  "Proceed using your best judgment and ask again if you still need a decision.\n";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Issue one poll, retrying connection-level failures (server unreachable) until
// the retry budget is spent. HTTP-level errors and malformed responses are real
// faults and propagate; they are not the no-answer case.
async function poll(env: CliEnv, req: PollRequest): Promise<AgentAskResponse> {
  const deadline = Date.now() + env.askRetryBudgetMs;
  for (;;) {
    let raw: unknown;
    try {
      raw = await request<unknown>(env, req);
    } catch (err) {
      if (err instanceof CliHttpError) throw err;
      if (Date.now() >= deadline) throw new AskUndeliverableError();
      await sleep(env.askRetryIntervalMs);
      continue;
    }
    return AgentAskResponseSchema.parse(raw);
  }
}

export const askCommand: Command = {
  name: "ask",
  summary: "Ask the human a question and block until they answer.",
  usage: ASK_USAGE,
  async run(ctx) {
    const parsed = parseArgs(ctx.args);
    const body: Record<string, unknown> = { question: parsed.question };
    if (parsed.options.length > 0) body["options"] = parsed.options;

    let res: AgentAskResponse;
    try {
      res = await poll(ctx.env, { method: "POST", path: "/agent/ask", body });
      while (res.resolution === "pending") {
        res = await poll(ctx.env, {
          method: "GET",
          path: `/agent/ask/${res.question_id}`,
        });
      }
    } catch (err) {
      if (err instanceof AskUndeliverableError) {
        ctx.stdout.write(NO_ANSWER_UNDELIVERABLE);
        return 0;
      }
      throw err;
    }

    if (res.resolution === "answered") {
      ctx.stdout.write(`${res.answer}\n`);
      return 0;
    }
    ctx.stdout.write(NO_ANSWER_CANCELLED);
    return 0;
  },
};
