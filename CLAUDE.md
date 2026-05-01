# Instructions for AI Assistants

> Guidelines for Claude Code working on Clobber

## What Clobber Is

A control room for multi-Claude orchestration. The user operates one or more **workspaces** (each tied to a work-source repo, e.g. a GitHub repo). Inside a workspace they see a **room** — a whiteboard where **agents** appear as circles. Clicking an agent opens its terminal panel. Agents ask questions via interactive widgets that appear above their head and in a sidebar. Persistent agents have **offices** (boxes on the whiteboard); ephemeral worker-bees come and go as issues arrive.

Clobber spawns `claude` sessions with generated `settings.json` whose hooks call back into Clobber, giving us live status, audit log, and decision-request UX. Agents also shell out to a `clobber` CLI for status updates, questions, and notes.

## Vocabulary (use these consistently in code and prose)

- **Role** — template/type definition. Bakes in runbooks, skills, triggers, standing orders. Versioned in code (e.g. `packages/runtime/src/roles/worker-bee.ts`).
- **Agent** — instance of a role inside a workspace. Has its own state, memory, desk, possibly an office on the whiteboard. May or may not currently have a session.
- **Session** — a `claude` process embodying an agent right now. Identified by claude's actual session ID (set explicitly via `claude --session-id <uuid>` at spawn). Resumable.
- **Workspace** — work-source (a repo) + a manager agent + an agent ceiling.
- **Room** — whiteboard view of a workspace.
- **Office** — persistent agent's box on the whiteboard.
- **Desk** — per-agent location for files/notes (`.clobber/agents/<id>/desk/`).

## Stack

- **TypeScript** everywhere. Strict mode. Advanced types where they buy DX.
- **Bun** runtime + bun workspaces.
- **Server**: Fastify + WebSocket + better-sqlite3.
- **Web**: React + Vite + Tailwind. Terminal panel uses xterm.js.
- **PTY**: node-pty. Sessions are real interactive terminals streamed to the UI.
- **Audit DB**: SQLite per-workspace. Every event keyed by `(agent_id, session_id)`.

## Monorepo Layout

- `packages/shared` — types + zod contracts shared across server/web/cli/runtime.
- `packages/server` — Fastify HTTP API + WebSocket + hook receivers + spawn logic + SQLite.
- `packages/web` — React + Vite + Tailwind UI.
- `packages/runtime` — role definitions + settings.json templates + hook scripts.
- `packages/cli` — `clobber` CLI binary agents shell out to (`status`, `ask`, `note`).

## Port Safety

🔒 Use ports **3000-3500** for development. **NEVER** kill processes on ports > 3500 (databases, system services, data loss risk).

## Engineering Rules

These mirror what works in adjacent projects. They are non-negotiable unless the user overrides per-task.

1. **TDD mandatory.** Failing test first, then implement. Integration tests over unit tests — write full-flow tests, not isolated function tests. No unit tests unless the user explicitly approves in a comment naming them.
2. **Test timeouts are bugs.** Never increase a timeout to make a test pass. Find the underlying async issue.
3. **No defensive programming.** No null checks, no `??`/`||` defaults, no swallowing errors. Unexpected data → throw. Defaults hide bugs. Only exception: comment with the user's name explicitly approving a defensive check.
4. **Files ≤ 300 lines.** Split by responsibility when crossing.
5. **No duplicated code.** Extract shared logic to a sensible place.
6. **No deprecated/legacy comments.** Replace, don't accumulate. If you remove code, just remove it — no "this used to be X" notes.
7. **Quality over speed.** No time pressure. Choose the maintainable approach.
8. **Forward-only.** Don't worry about backwards compatibility unless it's load-bearing.
9. **Type safety as DX.** Use mapped, conditional, generic, and `infer` types where they make autocomplete and correctness fall out naturally. The goal: the developer feels guided by the types.
10. **Comments explain why, not what.** Good names beat comments. Default to no comments.

## Worktree Rule

Past the bootstrap commits, no work directly on `main`. Use `git worktree add` for non-trivial branches.

## Stack-Specific Notes

- Sessions are spawned with `--session-id <clobber-uuid>` so we control the ID and can resume/audit.
- Hook scripts POST to Clobber's local HTTP API. `CLOBBER_URL` and `CLOBBER_AGENT_ID` (and `CLOBBER_SESSION_ID`) are passed via env on spawn.
- `clobber ask "<question>"` blocks until the UI replies; the reply is printed to stdout for the agent to read.
- `clobber status "<message>"` and `clobber note "<text>"` are fire-and-forget.
- Roles inherit. `WorkerBee` is the generic worker base; `Manager` extends with always-on cron triggers and a persistent office.

## Triggers

- v1 ships only **button** (user UI action).
- v2+ adds **cron**, **agent-to-agent events**, **GitHub webhooks**, **file watcher (desk)**, **external-session detected**.
- Trigger plumbing must be designed so adding a new kind is additive — no rewrites.

## What NOT to Do

1. Don't kill processes on ports > 3500.
2. Don't write unit tests without approval.
3. Don't add defensive null/error handling.
4. Don't commit `.env`, secrets, or anything in `.clobber/`.
5. Don't create new top-level docs files. Update `CLAUDE.md` and `README.md`.
6. Don't leave deprecated/legacy code or "removed because…" comments.
