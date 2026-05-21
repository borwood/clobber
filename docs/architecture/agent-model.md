# Agent model

> Status: north-star sketch, not a spec. Captures the conceptual model the codebase is moving toward. Specific issues in milestones `agent-runtime v1` and `agent-runtime v2` implement pieces of it. Update this doc when the model itself changes — not when an implementation detail does.

## Vocabulary (extends [README](../../README.md))

| Term | Definition |
|---|---|
| **Role** | Template/type. Bakes in system-prompt fragment, allowed CLI commands, skill bundle, settings overlay, hook scripts. Has a `persistent: bool` flag. |
| **Agent** | Instance of a role inside a workspace. If the role is persistent, the agent has a permanent **office** even when no session is currently embodying it. If non-persistent, the agent only exists for the lifetime of its session. |
| **Session** | Clobber's record of an agent embodiment. It points at a runtime provider, a provider thread when known, and the current/last process PID. State: `active \| paused \| ended`. |
| **Workspace** | Work source (a repo) + manager agent + agent ceiling. |
| **Office** | Persistent agent's permanent box on the whiteboard. Persists through session pause/end/respawn. |

## The three IPC directions

The system has exactly three communication directions between the clobber server and a spawned `claude`:

| Direction | Mechanism | Built? |
|---|---|---|
| **Inbound** — claude → clobber | Hook scripts (SessionStart/Stop/SessionEnd) POST to `/hooks/*`; transcript stream tailed from disk. | partial |
| **Embodiment** — clobber → claude | `claude -p --input-format stream-json` keeps the child alive; follow-up prompts written to its stdin. | yes (#8) |
| **Agent-initiated** — agent → clobber | `clobber` CLI shells out from inside the session; auths via per-session token in env; hits server endpoints. | no — milestone `agent-runtime v1` |

### Agent↔user — canonical channel

`AskUserQuestion` is the canonical agent-to-user channel. A `PreToolUse(AskUserQuestion)` hook (see `packages/server/src/ask-user-question-bridge.ts`) intercepts the native tool call, opens a clobber ask widget on the agent's office/desk, blocks until the human answers, and returns:

- `permissionDecision: "deny"` (PreToolUse's only viable shape — see caveat below)
- `permissionDecisionReason`: a single one-line stamp pointing the agent at `additionalContext`
- `additionalContext`: a **structured JSON string** carrying the actual answer

The JSON shape is:

```json
{
  "status": "answered" | "timed_out" | "cancelled",
  "question": "<verbatim question text>",
  "header": "<optional header>",
  "multi_select": true | false,
  "selections": [{ "label": "<answer label>", "option_index": 0 | null }],
  "raw": "<original answer string from the widget>",
  "dropped_question_count": <int>,
  "notes": ["..."]
}
```

`selections` is always present for `status: "answered"`. Single-select returns a one-element array. Multi-select returns the chosen labels in order; the widget submits them as `JSON.stringify(labels)` so commas inside labels are unambiguous. `option_index` is the zero-based index when the answer matches one of the options; `null` when the human typed a free-text override that doesn't match a label.

Net effect: any role with `AskUserQuestion` in its tool list gets the workspace-aware UX for free — no per-role prompt surgery toward `clobber ask`. `clobber ask` (`packages/cli/src/commands/ask.ts`) remains for explicit programmatic asks from scripts and skills.

Caveat: PreToolUse can only `allow / deny / ask / defer`, so the agent's transcript shows AskUserQuestion as denied-with-reason, not as a successful tool call. Future work could move the bridge to `PostToolUseFailure` + `updatedToolOutput` so the agent reads a normal-looking successful `tool_result` block instead. Multi-question `AskUserQuestion` calls today flatten to the first question; `dropped_question_count` and `notes` make the loss explicit. The native `permissionDecision: "defer"` decision is available in `claude -p` mode but is pause-and-resume, not skip-with-result — separate follow-up.

## Runtime provider boundary

Claude Code is the first runtime provider, not the conceptual model. Clobber
core should own agents, roles, workspaces, status, questions, audit history, and
the whiteboard. Runtime providers own concrete protocol details:

- spawn command shape
- process command execution and stdout event format
- role bundle materialization format
- prompt and interrupt serialization
- transcript path/discovery
- lifecycle/tool event normalization
- capability flags such as `processLifetime`, `livePromptInjection`,
  `interrupt`, and `resume`

This boundary exists even while Claude is the only production runtime. It keeps
provider-specific knowledge local and makes the codebase legible to agents that
only have partial context: look at the provider API to understand what the core
expects; look at one provider implementation to understand one runtime's
protocol.

The model must distinguish:

| Term | Meaning |
|---|---|
| **Agent** | Durable role instance inside a workspace. |
| **Provider thread** | Runtime-resumable conversation identity, such as a Claude session id or a Codex recorded session/thread id. |
| **Embodiment / run** | Concrete process PID and execution window. |

The `sessions` table therefore records both Clobber's local session id and
provider identity fields:

- `sessions.runtime_provider` names the provider implementation. The server
  defaults to `claude`; `CLOBBER_RUNTIME_PROVIDER=codex` selects the Codex
  provider.
- `sessions.provider_thread_id` stores the provider's resumable conversation
  identity when it is available. For Claude this is the same value as the local
  session id. Codex learns this id from `thread.started` stdout JSONL and
  updates the column asynchronously, so the column is nullable.
- `sessions.pid` remains process embodiment state. It is not a stable
  conversation identity and should not be used as a resume key.

Claude currently behaves like a **session-lifetime** process: a live child can
accept follow-up prompts over stdin until it exits. Codex `exec`, based on local
exploration of `codex-cli 0.129.0`, appears closer to a **turn-lifetime**
process: `codex exec --json` exits after `turn.completed`, while persistence is
handled by a resumable recorded session. Supporting both cleanly requires the
provider boundary to avoid assuming one logical session always equals one
long-lived process.

For turn-lifetime runtimes, a clean process exit does not end the Clobber
session. Follow-up prompts start a new provider process using
`sessions.provider_thread_id`; missing or unrecoverable provider threads surface
as explicit prompt errors instead of being mistaken for ordinary live-stdin
session death.

See [Codex Runtime Spike](./codex-runtime-spike.md) for the first captured
`codex exec --json` event shapes and the recommended initial Codex capability
set.

## Session lifecycle

```
        spawn               pause              resume                end
  Ø ─────────────► active ─────────► paused ─────────► active ─────────► ended
                     │                                                     ▲
                     └─────────────────────────────────────────────────────┘
                                          end
```

- `paused`: child process exits; row + transcript preserved; `claude --resume <session-id>` revives it. Distinct from `ended` (terminal) and from "agent crashed" (which today silently leaves rows looking active — see #11).
- `ended`: terminal. For non-persistent agents, this also destroys the agent. For persistent agents, the **agent persists** — only its current embodiment ends. The office stays.

## Persistence vs ephemerality

| | Persistent agent | Ephemeral agent |
|---|---|---|
| Office on whiteboard | yes (permanent) | only while session is active |
| Survives session end | yes (waits for next embodiment) | no (destroyed) |
| Created by | manager via `agent install` (or initial workspace setup) | manager via `agent invoke` / `clobber spawn` |
| Examples | a Slack-attentive assistant, a code reviewer that wakes on PR open | a one-shot worker given a focused task |

The manager-as-customization-shell consequence: persistent agents are how a workspace grows over time. The user adds capability by asking the manager to create them.

## The manager as workspace shell

The Manager role is the user's primary interface for *configuring the workspace itself*. Its skill surface is therefore not just "do work" — it's a **small admin API**, versioned, with strong contracts. Conceptual surface:

- **Spawn / lifecycle**
  - `clobber spawn <role> "<prompt>"` — ephemeral invocation
  - `clobber agent install <role> [--name <n>]` — create a persistent agent (gives it an office)
  - `clobber agent remove <agent-id>` — retire a persistent agent
  - `clobber agent pause/resume <agent-id>`
- **Role CRUD**
  - `clobber role list`
  - `clobber role create <name> --from-template <existing> --skills "<a,b,c>"`
  - `clobber role edit <name>`
  - `clobber role show <name>`
- **Coordination**
  - `clobber ask "<question>"` — escalate to the human
  - `clobber status <state> "<summary>"` — broadcast structured status
  - `clobber message <agent-id> "<text>"` — send a message to another agent (later — agent↔agent comm is its own design problem)
- **Introspection**
  - `clobber whoami`, `clobber workspace show`, `clobber agents list`

Not all of this lands at once. v1 covers spawn/ask/status/whoami. v2 covers persistence + role CRUD. Agent↔agent comm is its own future problem.

## Why this shape

- **Manager-mediated customization** keeps the user's surface area conversational, not configurational. The user describes capability they want; the manager turns it into roles + persistent agents + skill assignments. The clobber UI doesn't need a "create role" form — it has the manager.
- **Persistent ≠ embodied** decouples the *fiction* (an assistant lives here, has a desk, knows its context) from the *cost* (a `claude` process is expensive to keep idle). Persistence is cheap; embodiment is on-demand.
- **CLI as the only outbound path** keeps the agent-side contract narrow and testable. Skill markdown teaches *when* to call commands; the CLI enforces *how*. Server endpoints are the only thing the agent can affect.

## Roadmap

| Milestone | Theme | Issues |
|---|---|---|
| `agent-runtime v1` | Foundations: CLI, runtime bundle, spawn-time materialization, spawn/ask/status endpoints | #14–#19, closes #10 |
| `agent-runtime v2` | Persistent agents + workspace customization. **Roles-as-data scope locked — see § below.** | filed against milestone |

## Roles as data — v2 scope (decided 2026-05-04)

The Manager-as-workspace-shell vision (above) requires roles to be **mutable, versioned, workspace-scoped data** — not files in `packages/runtime/roles/`. v1 ships role bundles as filesystem artifacts; v2 promotes them to first-class data.

### Why now

`packages/runtime/roles/` works for shipped roles, but it has a split-brain: the DB has a role row with `name + permission_mode + allowed_tools`, the filesystem has the bundle (system prompt, skills). They can drift out of sync — observed when a `worker` role was created via `POST /roles` (DB row) but had no on-disk bundle, and `executeSpawn` silently launched a vanilla claude with no system prompt or skills. The fix isn't to unify on filesystem (then the manager can't author roles) — it's to unify on data, with shipped bundles becoming **seeds** that clone into each workspace on creation.

### Locked decisions

| Decision | Choice |
|---|---|
| Scope | **Workspace-local.** Each workspace owns its own role copies. Cross-workspace pollution cut at the schema. |
| Composition | **Fork + edit.** No inheritance graphs, no slot overrides. `clobber roles fork <id> <new-name>` copies the current version into a new role; edit freely from there. Cheap, traceable. |
| Versioning | **Immutable `role_versions` table; `roles.current_version_id` pointer.** Edit = insert new version + bump pointer. Spawn pins `sessions.role_version_id` so live sessions keep their boot version; new spawns pick up edits. |
| Editable surface (manager-authored) | `system_prompt`, `skills`, `allowed_tools`. |
| Locked surface (dev-only seeds) | `hooks`, `permission_mode`. **Why:** hooks are bash with workspace permissions; `permission_mode` controls whether claude bypasses tool prompts. Both are "give the agent code execution outside the agent" if LLM-authored. Revisit when there's a sandbox/audit story. |
| `allowed_tools` on fork | **Fully alterable** — expand or narrow. Forking is a starting-point convenience, not a constraint. |
| Shipped roles | First-boot seed: ship `manager` and a generic `worker` template. Cloned per-workspace on workspace create. Edits to seed sources don't propagate to existing workspaces (intentional — workspaces own their roles). |

### Implementation order

1. Schema (`role_versions` table, `sessions.role_version_id`, `roles.workspace_id`); load bundles from DB at spawn.
2. Seed shipped templates on workspace create; author the generic `worker` bundle.
3. Read API + `clobber roles list/show`.
4. Fork API + `clobber roles fork`.
5. Edit API + `clobber roles edit`.

### Deferred (not in v2)

- Hooks editable by manager (needs a sandbox/audit story).
- `permission_mode` editable.
- Inheritance / slot-based composition (revisit if fork-and-drift becomes painful).
- Role sharing across workspaces (export/import; "publish to library").
