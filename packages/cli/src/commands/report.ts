import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface ParsedReportArgs {
  readonly well?: string;
  readonly badly?: string;
  readonly useful?: string;
  readonly free_text?: string;
}

export function parseReportArgs(args: readonly string[]): ParsedReportArgs {
  let well: string | undefined;
  let badly: string | undefined;
  let useful: string | undefined;
  let freeText: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (tok === "--well" || tok === "--badly" || tok === "--useful") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        throw new CliUsageError(`${tok} requires a value`);
      }
      if (tok === "--well") well = value;
      else if (tok === "--badly") badly = value;
      else useful = value;
      i += 1;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      throw new CliUsageError(`report: unknown flag: ${tok}`);
    }
    if (freeText !== undefined) {
      throw new CliUsageError(
        `unexpected extra arguments: ${args.slice(i).join(" ")}`,
      );
    }
    freeText = tok;
  }

  if (
    well === undefined &&
    badly === undefined &&
    useful === undefined &&
    freeText === undefined
  ) {
    throw new CliUsageError(
      "missing report content: provide --well/--badly/--useful or a positional summary",
    );
  }
  if (
    freeText !== undefined &&
    (well !== undefined || badly !== undefined || useful !== undefined)
  ) {
    throw new CliUsageError(
      "report: positional summary is mutually exclusive with --well/--badly/--useful",
    );
  }

  const out: ParsedReportArgs = {};
  if (well !== undefined) (out as { well?: string }).well = well;
  if (badly !== undefined) (out as { badly?: string }).badly = badly;
  if (useful !== undefined) (out as { useful?: string }).useful = useful;
  if (freeText !== undefined) (out as { free_text?: string }).free_text = freeText;
  return out;
}

const REPORT_USAGE = `usage: clobber report [--well <text>] [--badly <text>] [--useful <text>]
       clobber report "<free-text summary>"

Submit the one final structured report for this session — what went well,
what went badly, what would have been useful. The report is recorded once
per session; calling twice is rejected.

Flags:
  --well <text>     What went well during this session.
  --badly <text>    What went badly or could have been better.
  --useful <text>   What would have made this session easier (a missing
                    skill, a missing piece of context, etc.).

Or pass a positional free-text summary if you don't have time to
structure it. Free-text and the structured flags are mutually exclusive.

Examples:
  clobber report --well "tests landed clean" --badly "spent too long re-reading"
  clobber report "shipped, no notes"`;

export const reportCommand: Command = {
  name: "report",
  summary: "Submit the final structured report for this session (once per session).",
  usage: REPORT_USAGE,
  async run(ctx) {
    const parsed = parseReportArgs(ctx.args);
    await request<{ ok: true }>(ctx.env, {
      method: "POST",
      path: "/agent/report",
      body: parsed,
    });
    return 0;
  },
};
