# Agent model

> Status: north-star sketch, not a spec. Captures the conceptual model the codebase is moving toward. Specific issues in milestones `agent-runtime v1` and `agent-runtime v2` implement pieces of it. Update this doc when the model itself changes — not when an implementation detail does.

## Vocabulary (extends [README](../../README.md))

| Term | Definition |
|---|---|
| **Role** | Template/type. Bakes in system-prompt fragment, allowed CLI commands, skill bundle, settings overlay, hook scripts. Has a `persistent: bool` flag. |
| **Agent** | Instance of a role inside a workspace. If the role is persistent, the agent has a permanent **office** even when no session is currently embodying it. If non-persistent, the agent only exists for the lifetime of its session. |
| **Session** | A `claude` process embodying an agent right now. State: `active \| paused \| ended`. Resumable by claude session id. |
| **Workspace** | Work source (a repo) + manager agent + agent ceiling. |
| **Office** | Persistent agent's permanent box on the whiteboard. Persists through session pause/end/respawn. |

## The three IPC directions

The system has exactly three communication directions between the clobber server and a spawned `claude`:

| Direction | Mechanism | Built? |
|---|---|---|
| **Inbound** — claude → clobber | Hook scripts (SessionStart/Stop/SessionEnd) POST to `/hooks/*`; transcript stream tailed from disk. | partial |
| **Embodiment** — clobber → claude | `claude -p --input-format stream-json` keeps the child alive; follow-up prompts written to its stdin. | yes (#8) |
| **Agent-initiated** — agent → clobber | `clobber` CLI shells out from inside the session; auths via per-session token in env; hits server endpoints. | no — milestone `agent-runtime v1` |

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
| Examples | a Slack-attentive assistant, a code reviewer that wakes on PR open | a one-shot worker bee given a focused task |

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
| `agent-runtime v2` | Persistent agents + workspace customization | TBD — placeholder milestone, no issues yet |

v2 won't be scoped until v1 is in hand and the actual ergonomics inform what we need.
