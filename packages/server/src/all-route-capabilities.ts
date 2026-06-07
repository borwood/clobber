// Authoritative list of every commandName string passed to withAgentAuth across
// all server route files. Must be kept in sync with the actual routes.
// The CLI capability registry convergence test (#554) cross-checks this list
// against CLI_CAPABILITY_REGISTRY from @clobber/shared — any mismatch is a bug.
export const ALL_ROUTE_CAPABILITY_NAMES: readonly string[] = [
  // agent-ask.ts
  "ask",
  // agent-cycle.ts
  "cycle",
  // agent-messages.ts
  "message",
  "reply",
  // agent-prompt-modules.ts
  "prompt-modules.edit",
  // agent-reports.ts
  "finding",
  "report",
  "reports",
  // agent-role-checkout.ts
  "roles.checkout",
  "roles.commit",
  "roles.diff",
  "roles.discard",
  "roles.status",
  // agent-role-edit-route.ts
  "roles.edit",
  // agent-role-upstream.ts
  "roles.fetch",
  "roles.upstream.diff",
  "roles.upstream.log",
  // agent-roles-prompt-modules.ts
  "roles.prompt-modules.add",
  "roles.prompt-modules.toggle",
  // agent-roles-wake-programs.ts
  "roles.wake-programs.add",
  "roles.wake-programs.edit",
  "roles.wake-programs.remove",
  // agent-roles.ts
  "roles.ceiling",
  "roles.delete",
  "roles.fork",
  "roles.list",
  "roles.show",
  // agent-self-skills.ts
  "self-skills.grant",
  "self-skills.list",
  "self-skills.release",
  // agent-sessions.ts
  "kill",
  "resume",
  "transcript",
  // agent.ts
  "agents",
  "spawn",
  "status",
  "whoami",
  // tool-token-test.ts
  "test-tool",
] as const;
