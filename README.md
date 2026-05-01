# Clobber

A control room for multi-Claude orchestration. Spawn, watch, and intervene in many `claude` sessions on a whiteboard-style room. Persistent agents (managers, reviewers) keep working in the background even when no LLM brain is currently embodying them.

> Status: scaffolding. Not usable yet.

## Vocabulary

- **Role** — template/type definition (`WorkerBee`, `Manager`, …). Bakes in runbooks, skills, triggers, standing orders.
- **Agent** — instance of a role inside a workspace. May or may not currently have a session.
- **Session** — a `claude` process embodying an agent right now. Identified by claude's actual session ID; resumable.
- **Workspace** — work-source (a repo) + manager agent + agent ceiling.
- **Room** — whiteboard view of a workspace.
- **Office** — persistent agent's box on the whiteboard.
- **Desk** — per-agent location for files/notes.

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

See `CLAUDE.md` for engineering rules.
