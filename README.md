# Clobber

A control room for multi-Claude orchestration. Spawn, watch, and intervene in many `claude` sessions on a whiteboard-style room. Persistent agents (managers, reviewers) keep working in the background even when no LLM brain is currently embodying them.

> Status: scaffolding, but the loop below works end to end.

## Quickstart

Every command here was run verbatim against a fresh clone during the #683 cold-start pass.
Requires only [Bun](https://bun.sh) and `git`.

```sh
git clone https://github.com/brennan-volter/clobber.git
cd clobber
bun install
bun run type-check   # sanity check — should print nothing and exit 0
```

Start the server (default port 3370 — pick another with `CLOBBER_PORT` if that's taken):

```sh
cd packages/server
bun run dev
```

In a second terminal, from the repo root, create a workspace pointed at any local git repo
(here, a throwaway one) using the operator-level `clobber workspace create` command — it talks to
the server over `CLOBBER_API_BASE` only, no agent session required:

```sh
mkdir -p /tmp/clobber-demo-repo && cd /tmp/clobber-demo-repo
git init -q && git commit -q --allow-empty -m init

mkdir -p /tmp/clobber-demo-config
cat > /tmp/clobber-demo-config/workspace.config.json <<'EOF'
{ "name": "demo", "repo_path": "/tmp/clobber-demo-repo" }
EOF

cd -   # back to the clobber checkout
CLOBBER_API_BASE=http://127.0.0.1:3370 \
  bun packages/cli/src/index.ts workspace create --config /tmp/clobber-demo-config --json
```

That prints the created workspace's `id`. Find the seeded `worker` role's id for that workspace:

```sh
curl -s http://127.0.0.1:3370/roles | python3 -c \
  'import json,sys; [print(r["id"]) for r in json.load(sys.stdin) if r["name"]=="worker"]'
```

Spawn a worker with a trivial task (no manager needed for a smoke test — `/spawn` is also
operator-level):

```sh
curl -s -X POST http://127.0.0.1:3370/spawn -H "Content-Type: application/json" -d '{
  "workspace_id": "<workspace id from above>",
  "role_id": "<worker role id from above>",
  "label": "smoke-test",
  "wake_program": "custom",
  "prompt": "Append hello to a new file hello.txt in the repo root, then run: clobber status done \"done\". Do not commit."
}'
```

Watch it land — the whiteboard route shows live status without needing the browser:

```sh
curl -s http://127.0.0.1:3370/workspaces/<workspace id>/whiteboard | python3 -m json.tool
```

Once `session.latest_status.state` reads `"done"`, the loop closed: clone → server → workspace →
worker → status, no hidden setup steps. The same server also serves the web UI's API — run
`bun run dev` in `packages/web` (port 3470 by default) to watch it happen on the whiteboard instead
of via curl.

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
