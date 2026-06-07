// #554 — single source of truth for agent CLI capabilities.
// Keyed by the exact commandName string passed to withAgentAuth on the server.
// Consumed by: server authz (Step 3), perms doc (2f), docs:gen (2b).
// NO `tiers` field — deferred to Step 4 (no consumer until then).

export type CliCapabilityTag = "read" | "write" | "admin";

export interface CliCapability {
  readonly name: string;
  readonly description: string;
  readonly tag: CliCapabilityTag;
  readonly internal?: boolean;
}

export const CLI_CAPABILITY_REGISTRY: Readonly<Record<string, CliCapability>> = Object.freeze({
  // ── read ─────────────────────────────────────────────────────────────────
  // Observe-only: returns state without mutating anything.

  "agents": {
    name: "agents",
    description: "List live agents in the current workspace.",
    tag: "read",
  },
  "reports": {
    name: "reports",
    description: "Read worker final-reports and findings.",
    tag: "read",
  },
  "roles.diff": {
    name: "roles.diff",
    description: "Show working-copy changes against the checked-out role's branch tip.",
    tag: "read",
  },
  "roles.list": {
    name: "roles.list",
    description: "List roles available in the current workspace.",
    tag: "read",
  },
  "roles.show": {
    name: "roles.show",
    description: "Show a role's current version, history, and configuration.",
    tag: "read",
  },
  "roles.status": {
    name: "roles.status",
    description: "Show whether a role checkout is open and which files changed.",
    tag: "read",
  },
  "roles.upstream.diff": {
    name: "roles.upstream.diff",
    description: "Line-level diff of the local role pin versus its upstream default.",
    tag: "read",
  },
  "roles.upstream.log": {
    name: "roles.upstream.log",
    description: "List upstream commits not yet in the local role pin.",
    tag: "read",
  },
  "self-skills.list": {
    name: "self-skills.list",
    description: "List the current role's granted self-skills and workspace policy.",
    tag: "read",
  },
  "transcript": {
    name: "transcript",
    description: "Read a session's transcript.",
    tag: "read",
  },
  "whoami": {
    name: "whoami",
    description: "Return the caller's session and role identity.",
    tag: "read",
  },

  // ── write ─────────────────────────────────────────────────────────────────
  // Agent work-voice: the agent's own output stream (status, questions, reports).

  "ask": {
    name: "ask",
    description: "Post a blocking question to the user and await the answer.",
    tag: "write",
  },
  "finding": {
    name: "finding",
    description: "Submit a freetext triage finding.",
    tag: "write",
  },
  "message": {
    name: "message",
    description: "Send a message to another session in the workspace.",
    tag: "write",
  },
  "reply": {
    name: "reply",
    description: "Reply to a received message.",
    tag: "write",
  },
  "report": {
    name: "report",
    description: "Submit the session's structured final-report.",
    tag: "write",
  },
  "status": {
    name: "status",
    description: "Post the agent's current status string.",
    tag: "write",
  },

  // ── admin ─────────────────────────────────────────────────────────────────
  // Mutate the control plane: spawn agents, modify roles, manage sessions.
  // NOTE: roles.fetch tagged admin (mutates upstream refs); revisit at Step 3.
  // NOTE: agent-voice verbs tagged write (no 4th voice/base tag in v1).

  "cycle": {
    name: "cycle",
    description: "Kill and reseat the current session (tool-token-gated).",
    tag: "admin",
  },
  "kill": {
    name: "kill",
    description: "Terminate a session in the current workspace.",
    tag: "admin",
  },
  "prompt-modules.edit": {
    name: "prompt-modules.edit",
    description: "Replace a prompt-module's definition in the workspace catalog.",
    tag: "admin",
  },
  "resume": {
    name: "resume",
    description: "Resume or restart a session in the current workspace.",
    tag: "admin",
  },
  "roles.ceiling": {
    name: "roles.ceiling",
    description: "Set the spawn ceiling for a role in this workspace.",
    tag: "admin",
  },
  "roles.checkout": {
    name: "roles.checkout",
    description: "Open a role's branch as a working copy in the desk.",
    tag: "admin",
  },
  "roles.commit": {
    name: "roles.commit",
    description: "Commit working-copy edits onto the role branch and advance the pin.",
    tag: "admin",
  },
  "roles.delete": {
    name: "roles.delete",
    description: "Remove a role, its fork-branch, and its config refs.",
    tag: "admin",
  },
  "roles.discard": {
    name: "roles.discard",
    description: "Discard working-copy changes without committing.",
    tag: "admin",
  },
  "roles.edit": {
    name: "roles.edit",
    description: "Apply a one-shot patch to a role without a working-copy round-trip.",
    tag: "admin",
  },
  "roles.fetch": {
    name: "roles.fetch",
    description: "Refresh upstream remote-tracking refs in the workspace role clone.",
    tag: "admin",
  },
  "roles.fork": {
    name: "roles.fork",
    description: "Create a new role as a fresh branch forked from a source role.",
    tag: "admin",
  },
  "roles.prompt-modules.add": {
    name: "roles.prompt-modules.add",
    description: "Append a prompt-module ref to a role.",
    tag: "admin",
  },
  "roles.prompt-modules.toggle": {
    name: "roles.prompt-modules.toggle",
    description: "Toggle a prompt-module ref's enabled flag on a role.",
    tag: "admin",
  },
  "roles.wake-programs.add": {
    name: "roles.wake-programs.add",
    description: "Add a wake-program to a role.",
    tag: "admin",
  },
  "roles.wake-programs.edit": {
    name: "roles.wake-programs.edit",
    description: "Edit an existing wake-program on a role.",
    tag: "admin",
  },
  "roles.wake-programs.remove": {
    name: "roles.wake-programs.remove",
    description: "Remove a wake-program from a role.",
    tag: "admin",
  },
  "self-skills.grant": {
    name: "self-skills.grant",
    description: "Grant a skill to the current role (within workspace policy).",
    tag: "admin",
  },
  "self-skills.release": {
    name: "self-skills.release",
    description: "Remove a granted self-skill from the current role.",
    tag: "admin",
  },
  "spawn": {
    name: "spawn",
    description: "Spawn a new agent in the current workspace.",
    tag: "admin",
  },
  "test-tool": {
    name: "test-tool",
    description: "Internal tool-token test endpoint (dev/test only).",
    tag: "admin",
    internal: true,
  },
});

export function getCliCapability(name: string): CliCapability | undefined {
  return CLI_CAPABILITY_REGISTRY[name];
}
