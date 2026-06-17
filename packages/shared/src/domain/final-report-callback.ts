import { z } from "zod";

// Tagged-union shape for the per-workspace consumer of final-report rows.
// The engine ships the pipeline + these three kinds; workspaces compose
// the action they want (file a GitHub issue, POST to Slack, etc.) via
// exec or http. New kinds plug in additively — add a branch to the union
// and an arm to the consumer's dispatch switch.
//
// The name is "callback" but the contract is request/response — exec
// reports failure via non-zero exit, http via non-2xx. A future kind
// that carries instructions back from the consumer (e.g. manager-driven
// autonomy) can extend the response surface without breaking the
// fire-and-forget kinds.
export const FinalReportCallbackNoopSchema = z.object({
  kind: z.literal("noop"),
});

export const FinalReportCallbackExecSchema = z.object({
  kind: z.literal("exec"),
  command: z.string().min(1).meta({ title: "Command", description: "Executable run with the report JSON on stdin." }),
  args: z.array(z.string()).meta({ title: "Arguments" }).optional(),
});

export const FinalReportCallbackHttpSchema = z.object({
  kind: z.literal("http"),
  url: z.string().url().meta({ title: "URL", description: "Endpoint the report JSON is POSTed to." }),
  headers: z.record(z.string(), z.string()).meta({ title: "Headers" }).optional(),
});

export const FinalReportCallbackSchema = z
  .discriminatedUnion("kind", [
    FinalReportCallbackNoopSchema,
    FinalReportCallbackExecSchema,
    FinalReportCallbackHttpSchema,
  ])
  .meta({
    title: "Final-report callback",
    description: "What runs when an agent files its final report — nothing, a shell command, or an HTTP POST.",
  });
export type FinalReportCallback = z.infer<typeof FinalReportCallbackSchema>;

export const DEFAULT_FINAL_REPORT_CALLBACK: FinalReportCallback = {
  kind: "noop",
};

// What the consumer hands to the configured callback. exec gets this on
// stdin as JSON; http POSTs it as the request body. Stable shape — adding
// fields is fine, renaming or removing is a breaking change for workspace
// scripts and external endpoints.
export const FinalReportPayloadSchema = z.object({
  workspace_id: z.string(),
  agent_id: z.string(),
  session_id: z.string(),
  kind: z.literal("final-report"),
  state: z.string(),
  summary: z.string(),
  report: z.record(z.string(), z.unknown()),
  created_at: z.number().int().nonnegative(),
  log_id: z.number().int().nonnegative(),
});
export type FinalReportPayload = z.infer<typeof FinalReportPayloadSchema>;
