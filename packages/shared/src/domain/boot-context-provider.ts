import { z } from "zod";

// Tagged-union shape for the per-workspace provider of agent boot-context.
// The engine ships the seam + these three kinds; workspaces compose the
// source they want (return the last N wisdom-log entries, fetch an
// onboarding doc, etc.) via exec or http. New kinds plug in additively —
// add a branch to the union and an arm to the runner's dispatch.
//
// This is the inbound mirror of FinalReportCallback (final-report-callback.ts):
// that union fires text *out* at session end; this one pulls text *in* at
// spawn. Same {noop|exec|http} shape, opposite direction. They are
// deliberately kept separate until a third caller justifies unifying them
// into one WorkspaceExternalHook primitive (Rule of Three).
export const BootContextProviderNoopSchema = z.object({
  kind: z.literal("noop"),
});

export const BootContextProviderExecSchema = z.object({
  kind: z.literal("exec"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

export const BootContextProviderHttpSchema = z.object({
  kind: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const BootContextProviderSchema = z.discriminatedUnion("kind", [
  BootContextProviderNoopSchema,
  BootContextProviderExecSchema,
  BootContextProviderHttpSchema,
]);
export type BootContextProvider = z.infer<typeof BootContextProviderSchema>;

export const DEFAULT_BOOT_CONTEXT_PROVIDER: BootContextProvider = {
  kind: "noop",
};

// What the runner hands to the configured provider. exec gets this on stdin
// as JSON; http POSTs it as the request body. The provider returns text
// (stdout / response body) that is injected verbatim into the spawn prompt.
// Stable shape — adding fields is fine, renaming or removing is a breaking
// change for workspace scripts and external endpoints.
export const BootContextSchema = z.object({
  workspace_id: z.string(),
  agent_id: z.string(),
  role_id: z.string(),
  role_name: z.string(),
  persistent: z.boolean(),
});
export type BootContext = z.infer<typeof BootContextSchema>;
