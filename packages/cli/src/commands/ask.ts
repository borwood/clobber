import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface ParsedArgs {
  readonly question: string;
  readonly options: readonly string[];
}

interface AskResponse {
  readonly resolution: "answered" | "cancelled" | "timed_out";
  readonly answer?: string;
}

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

export const askCommand: Command = {
  name: "ask",
  summary: "Ask the human a question and block until they answer.",
  async run(ctx) {
    const parsed = parseArgs(ctx.args);
    const body: Record<string, unknown> = { question: parsed.question };
    if (parsed.options.length > 0) body["options"] = parsed.options;
    const res = await request<AskResponse>(ctx.env, {
      method: "POST",
      path: "/agent/ask",
      body,
    });
    if (res.resolution === "answered") {
      if (res.answer === undefined) {
        throw new Error("server returned answered without an answer");
      }
      ctx.stdout.write(`${res.answer}\n`);
      return 0;
    }
    if (res.resolution === "timed_out") {
      ctx.stderr.write("ask: timed out waiting for an answer\n");
      return 1;
    }
    ctx.stderr.write("ask: cancelled (session ended)\n");
    return 1;
  },
};
