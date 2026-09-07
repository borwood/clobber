# Clobber

Clobber is an office for Claude Code agents. Open a workspace on a repo and a
persistent **manager** takes the first permanent desk in it. Discuss your preferred
workflows, where to source context from (GitHub/Jira CLI, local docs?), and manager
will define agent roles with the context, guards, and triggers you need by forking
the built-in manager and worker roles. Hand the manager (or a custom dispatch role)
issues and decisions, and it spawns ephemeral **workers** at the desks around
it to carry the implementation work: write the failing test, make it pass,
open the PR, watch CI. The **whiteboard** shows the office live, so you can
walk in on several sessions at once without reading several transcripts.

> **Status: open-sourced, no longer maintained.** Clobber was a personal
> harness, built for and used on real work — the repos it managed include
> this one; much of Clobber was built by agents Clobber was orchestrating.
> It's published as-is: the loops documented below run end to end against a
> real server, and the quickstart was verified against a fresh clone. There
> is no roadmap and no support. Fork freely. Some of the features that makes
> Clobber unique are now first-class in the Claude Code harness, including
> inter-agent messaging, scratch pad, and agent teams.
> Its unique upgrades are listed below.

## What Clobber affords

Everything here rides **headless Claude Code sessions** — Clobber spawns the
`claude` CLI you already have, so agents run on your existing subscription.
No separate API billing, no second auth model.

- **Versioned roles.** Every agent embodies a **role** — a template baking in
  a system prompt, skill bundle, allowed tools, triggers, and (for autonomous
  roles) an SDLC profile. Role state lives in a git repo of its own: edits are
  commits, workspaces pin a sha, and a running agent's contract can't be
  yanked out from under it by an engine update.
- **Persistent agents with self-handoff.** You can define special 'persistent'
  roles for which there is at most one live session, inheriting the same scratch
  directory for notes and scripts. These agents can use the `clobber` CLI to
  cycle - restart their own session from fresh context, with a self-authored handoff
  note - to manage long-running tasks like agent dispatch, harvest, and reports triage.
  With clobber hooks, these agents can have reminders to cycle when their context usage
  grows past an effective length.
- **DRY context machinery.** Prompt-modules, seeds, and a shared base layer
  let roles share context components instead of copy-pasting prompt prose.
  Compose once, project into every role that needs it; workspace-specific
  overlays shadow engine defaults without forking them.
- **Hooks beyond the native set.** Every native Claude Code hook event
  (session start/end, each tool use, prompts, stop, pre-compact) streams into
  a per-workspace audit log keyed by agent and session — the raw material for
  clocking session length and spend per agent. On top of that, completion
  triggers broadcast when a worker is done or its session dies, and blocking
  questions surface the moment a worker is stuck. A **habits** layer compiles
  user-defined event→action rules down onto the native hooks.
- **Task-list injection.** A dispatch can seed a phase plan onto the agent's
  task list at spawn; task-tool calls are hooked server-side and reduced into
  phase-transition events, so the floor shows "writing test → opening PR →
  watching CI" without the agent narrating it.
- **Agent–agent orchestration.** Managers spawn, message, resume, and reap
  workers; triggers (workspace-open, webhooks, cron, completion wakes) wake
  persistent agents without a human prompt; one-shot reply tokens let a
  worker answer its manager mid-flight.
- **A self-healing workspace.** Workers file structured final reports (what
  went well, what went badly) and fire-and-forget findings when they hit
  friction. Full transcripts of every session are auditable after the fact.
  Roles can be put in charge of the feedback loop itself — reading reports,
  auditing worker sessions, and patching the context problems other agents
  report, so the workspace tightens its own runbooks over time.
- **A UI built for parallel sessions.** A grid-style layout you arrange into
  panes — transcripts, the live whiteboard, spawn controls, reports — for
  organizing views of many concurrent sessions. Per-workspace theming and
  fast workspace tabs make juggling several projects in parallel legible at
  a glance. With the `clobber` CLI, agents you authorize have the same
  view of the workspace you do, and the power to notice and fix its frictions.


Roles talk back to Clobber through a small `clobber` CLI, authenticated
per-session, so status updates and blocking questions land on the whiteboard
instead of getting lost in a terminal nobody's watching. When an agent hits a
decision it can't make alone, it asks — a widget pops on its desk or office
and mirrors into a sidebar, so a question doesn't get buried under a busy
floor.

## Getting started

Requires [Bun](https://bun.sh), `git`, and a working [Claude Code](https://claude.com/claude-code)
install (agents run as headless `claude` sessions on your subscription).

```sh
git clone https://github.com/borwood/clobber.git
cd clobber
bun install
bun run dev
```

That starts the server (port 3370) and the web UI — open **http://localhost:3470**.

**Add a workspace.** Press the **`+` button** in the workspace tab row at the
top, then **"new workspace…"** at the bottom of the dropdown. Give it a name
and the absolute path to the repo it should manage (the `browse…` button opens
a folder picker). The selected directory **must already be a git repository**
— the server rejects a path without a `.git` in it.

**Session onboarding.** The workspace is created with its manager agent
already in place. The first time you open the workspace, a **manager session
starts automatically** and runs the **bootstrapping interview**: it asks about
your repo and stack, which roles to enable, which SDLC phases workers should
follow, and any workflow hazards or conventions worth telling every future
agent once. Your answers are woven into the workspace's roles as context, and
a sentinel file (`.clobber/bootstrap.json` in your repo) marks onboarding
done so the interview never re-fires. From then on, opening the workspace is
an ordinary wake — hand the manager work, or spawn workers directly.

## Vocabulary

- **Role** — template/type definition (`Worker`, `Manager`, …). Bakes in runbooks, skills, triggers, standing orders, and (for autonomous roles) an `sdlc` profile.
- **Agent** — instance of a role inside a workspace. **Persistent** agents exist with or without a live session; **ephemeral** agents exist only while embodied.
- **Session** — a `claude` process embodying an agent right now. Identified by claude's actual session ID; resumable.
- **Workspace** — work-source (a repo) + manager agent + agent ceiling.
- **Room** — whiteboard view of a workspace.
- **Office** — permanent box on the whiteboard belonging to a *persistent* agent (the shipped `manager` role is one). Stays on the board even when nothing is embodying the agent. Each office is backed by a per-agent directory inside `.clobber/` in the workspace cwd, where the agent stores notes-to-self and other files that should outlive any single session.
- **Desk** — temporary spot on the room's shared floor for an *ephemeral* agent (e.g. a default Worker). Appears when the agent is spawned; disappears when the session ends. Ephemeral agents have no persistent directory of their own.

## How it feels

You walk into a workspace. The Manager's office and any other persistent agents' offices are always there. Workers come and go on the shared floor as their tasks are spawned and finish.

**First open.** The first time a workspace's manager wakes — a `workspace-open` trigger guarded on the absence of `.clobber/bootstrap.json` — it runs a short interview instead of anything else: your repo/stack, which SDLC phases to ratify, which shipped roles to enable, and any hazards or conventions worth telling every future agent once instead of leaving them to rediscover it. The answers become a `project-context` prompt-module wired onto the worker role, and the sentinel file marks the interview done so it never re-fires.

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

## Rehearsing a DB migration

`createDatabase` runs an ordered set of schema migrations on boot. Fresh databases get every
column from the `CREATE TABLE` schema, so the suite's `:memory:` migration tests never exercise the
*existing-DB upgrade path* — the gap that let #339 ship green and crash on the first real boot.

Two guards close it:

- **Existing-DB harness** — `packages/server/src/migration-harness.ts` exposes `buildAndRegress`
  (build a populated current-schema DB → surgically downgrade it → close, so a test can reopen
  through the real `createDatabase`) plus `captureShape`/`diffShapes`. Add a "migrate a DB shaped
  like X" case in `packages/server/tests/migration-harness.test.ts`.
- **One-command dry-run against real data** — rehearse the current code's migrations on a *copy* of
  the live database before they touch the original:

  ```
  bun packages/cli/src/index.ts db-dryrun        # or: clobber db-dryrun
  ```

  It opens the live `clobber.db` **read-only**, snapshots it to a temp copy via `VACUUM INTO`, runs
  the full migration sequence on the copy, and prints the schema diff. The live file is never
  written. `--db <path>` targets another database; `--keep` retains the migrated copy for inspection.

See `CLAUDE.md` for engineering rules and `docs/architecture/agent-model.md` for the design north-star (vocabulary in depth, IPC directions, session lifecycle, manager-as-workspace-shell, roles-as-data v2 scope).

## Why this exists, and why it stops here

Clobber is a checkpoint: condensed wisdom from a stretch of AI-first
development, where the question behind every feature was the same — *how do
you deliver the right context at every available juncture so agents are
effective, and the surface area for misjudgement shrinks?* Versioned roles,
shared prompt-modules, hook fan-in, task seeding, self-auditing reports — each
is one answer to that question, frozen here in working form.

The exploration continues elsewhere, in newer shapes. This repo stays as the
record of what that question looked like answered with an office.

## License

[MIT](LICENSE).
