# Clobber

A control room for multi-Claude orchestration. Spawn, watch, and intervene in many `claude` sessions on a whiteboard-style room. Persistent agents (managers, reviewers) keep working in the background even when no LLM brain is currently embodying them.

> Status: scaffolding. Not usable yet.

## Vocabulary

- **Role** — template/type definition (`Worker`, `Manager`, …). Bakes in runbooks, skills, triggers, standing orders, and (for autonomous roles) an `sdlc` profile.
- **Agent** — instance of a role inside a workspace. **Persistent** agents exist with or without a live session; **ephemeral** agents exist only while embodied.
- **Session** — a `claude` process embodying an agent right now. Identified by claude's actual session ID; resumable.
- **Workspace** — work-source (a repo) + manager agent + agent ceiling.
- **Room** — whiteboard view of a workspace.
- **Office** — permanent box on the whiteboard belonging to a *persistent* agent (e.g. Manager, Reviewer). Stays on the board even when nothing is embodying the agent. Each office is backed by a per-agent directory inside `.clobber/` in the workspace cwd, where the agent stores notes-to-self and other files that should outlive any single session.
- **Desk** — temporary spot on the room's shared floor for an *ephemeral* agent (e.g. a default Worker). Appears when the agent is spawned; disappears when the session ends. Ephemeral agents have no persistent directory of their own.

## How it feels

You walk into a workspace. The Manager's office and any other persistent agents' offices are always there. Workers come and go on the shared floor as their tasks are spawned and finish.

**Triggers wake persistent agents.** A persistent agent — typically the Manager — can carry standing orders that fire on events (a new issue assigned to you, a webhook, a PR opened) or on a cron. The Manager wakes itself up to triage incoming work, scan PRs, or audit roles, without a human prompt. Ephemeral workers don't carry triggers; they're spawned per task.

**Asking, not guessing.** Any agent — worker or manager — can use the `ask` skill to escalate uncertainty to the human. The question widget renders on the asking agent's own desk or office *and* in a global sidebar so you can triage without staring at the board. Worker asks are not relayed through the manager; the manager is itself a first-class consumer of `ask` (e.g. during triage, when an incoming issue is missing info or might be bundled with another).

**Manager as role engineer.** The Manager doesn't only dispatch work. It reads transcripts, audits worker behavior, and forks/edits roles to bake in new skills or standing orders — so the workspace gets better at its own work over time.

## Stack

TypeScript, Bun, Fastify, React + Vite, Tailwind, better-sqlite3, node-pty, xterm.js.

## Layout

```
packages/
  shared/   # types + zod contracts
  server/   # fastify + ws + sqlite + hook receivers + spawn
  web/      # react ui
  runtime/  # role definitions + settings.json templates + hook scripts
  cli/      # `clobber` binary agents shell out to
```

See `CLAUDE.md` for engineering rules and `docs/architecture/agent-model.md` for the design north-star (vocabulary in depth, IPC directions, session lifecycle, manager-as-workspace-shell, roles-as-data v2 scope).
