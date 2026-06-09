# Instructions for AI Assistants

> Guidelines for Claude Code working on Clobber

## Vision

Clobber is a structured environment that sits above ephemeral Claude Code sessions, organized around the human-intelligible metaphor of an office workspace and the workers inside it.

You open Clobber on a workspace tied to a repo. A **manager** agent has a permanent office in the corner. You drop them issues, decisions, and open questions; they spawn ephemeral **worker** agents to do the implementation work. Workers spin up at empty desks, follow the repo's runbooks through the SDLC, and most of the time finish autonomously through PR creation and CI monitoring (bypassPermissions mode).

When a worker hits a decision it can't make alone, it taps you on the shoulder: a small interactive widget pops above its desk (buttons for options, free text for overrides) and is **mirrored in a sidebar** so you can't miss it even when you're not looking at the floor. The sidebar is the safety net for when many agents are working at once and you can't track them all.

Workers emit status updates at every SDLC phase transition ("writing test", "opening PR", "watching CI") so the floor is always honest about what's happening. When a worker finishes, it submits a final report with what went well and what could have been better.

The **manager wakes on intervals and at session boundaries**. It scans open issues for readiness, raises questions when issues conflict with each other or with prior decisions, and groups related work under a parent issue using GitHub's **sub-issue relationship** — never closing the related issues, only linking them as children of the parent. The manager documents its reasoning as comments on the relevant issues and then spawns workers via skill invocations like `/assignment <issue numbers> <any additional notes>`. After a worker session ends, the manager wakes again to decide whether there is enough work to spawn another agent for the next job.

The workspace is **self-auditing**. Workers' "could have been better" reports auto-file internal tickets; novel problems encountered mid-session do the same via hooks — an internal ticketing system. The manager triages this queue and decides whether the runbooks or the skills issued to workers need to be revised. Over time the workspace learns and the runbooks tighten.

Two foundational systems make this possible:

1. **Role designation.** Every agent has a role. Roles are templates (persistent vs. ephemeral, permission mode, allowed tools, eventually runbook + skills). Workspaces have ceilings per role (e.g. one manager, three workers). The same role can be reused across workspaces.
2. **Skills + hooks.** Claude's hook system is wired into the Clobber server: hooks let agents update status, pop widgets for user decisions, signal phase changes, and emit final reports. Skills like `/assignment` are how the manager gives a worker its initial context. Agents also shell out to a `clobber` CLI for fire-and-forget status updates, blocking question-asking, and notes.

### UI views

The workspace can be viewed three ways. Start with the simplest, design for the others:

- **Grid** (build first) — one panel per agent: role, status, assignment, transcript link, popped widget. Easiest to reason about and the natural progression from the current UI.
- **Kanban** — same panels, arranged in columns by SDLC status.
- **Office** — agents as circles on a floor; persistent agents sit in their fixed offices, ephemeral agents occupy desks that move by status. The most evocative view, the one the metaphor is named for.

A widget popped above an agent **always** also appears in the sidebar.

Clobber spawns `claude` sessions with generated `settings.json` whose hooks call back into Clobber, giving us live status, audit log, and decision-request UX.

## Vocabulary (use these consistently in code and prose)

- **Role** — template/type definition. Bakes in runbooks, skills, triggers, standing orders, and (for autonomous roles) an `sdlc` profile. Versioned in code (e.g. `packages/runtime/roles/worker/manifest.ts`).
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

## Golden Rules

Clobber is a long-lived engine that future AI agents will work on. These four rules sit above the Engineering Rules below — the engineering rules are the *how*, these are the *why* every change is shaped the way it is.

1. **Re-use.** Before writing anything new, look for an existing component to compose or abstract. New components need a *genuine novel-requirements* justification — not "it was easier to write fresh." If an existing one is *almost right*, the work is to generalize it, not duplicate it. *Composition over creation.*
2. **Modularity.** API/interface-forward. Layers of abstraction, generics, implementation-agnostic cores wired to swappable adapters. The bet is that future AI agents will need to replace pieces — from a component to a service to a whole engine layer — and design today should make those swaps cheap. *Interfaces over implementations.*
3. **Flexibility.** Clobber is not opinionated about the user's workflow, their preferred SDLC, their roles, their permissions, their policies. It's an engine that ships *sensible defaults for the popular cases* and exposes the seams so any workspace can adapt. Never hard-bake one workflow as *the* workflow. *Engine, not opinion.*
4. **Ritual.** TDD + typecheck on every change (see Engineering Rules 1 below). Before coding on a new issue, write a north-star narrative via `/clobber-pm narrative write` and confirm comprehension with the human before logging. Run the **blue-sky reframe** — *"what could this feature be if it were insanely useful, novel, enjoyable, dependable?"* — and surface only the genuinely interesting reframes, not every option. When you touch code that doesn't conform to the rules above, raise it: small fold-in fixes get a one-line gesture in the end-of-turn summary; heavier refactors get a "should this be a separate work item?" question.
5. **Horizontal spines.** Express a new capability as a spine riding shared compositional
   substrates — never as a parallel one-off. When two features need the same shape, build the
   substrate once and have both ride it. *Substrates over silos.*
6. **Single typed source per concern.** Exactly one authoritative, typed schema/contract per
   concern; everything programmatic (docs, validation, wiring) is projected or derived from it.
   Contracts fail LOUD, and a loud failure is precious signal: don't just satisfy it —
   interrogate whether the schema itself must evolve, and check its other consumers. The schema
   is not sacred; it matures with the codebase. *One source, many projections.*
7. **Can't-fail beats best-effort for primitives.** For a load-bearing primitive, make the bad
   outcome structurally impossible — idempotent, type-enforced, DB-constrained — not filtered or
   compensated after the fact. Best-effort is acceptable only when no structural path exists,
   and that impossibility must be argued, not assumed. Prefer structurally-armed boundaries over
   remembered companion steps. *Impossible over improbable.*
8. **The tip is the agent; the past is a resource.** Deliver to the current embodiment of an
   agent, never a superseded one; treat history as supersession by lineage, not staleness by
   wall-clock. A pending obligation outlives restarts and targets whoever the agent is now.
   *Lineage over wall-clock.*

**The engine/workspace seam — LAW.** GR3 sharpened into an enforced rule. An engine **default** is a *generality contract*: anything that ships as a default — a default role or manifest, a default prompt-module/seed, a plugin-template skill, an engine runbook — MUST be generic enough to serve *any* clobber workspace. Workspace-specific content (a repo's own scars, conventions, known hazards, issue/PR numbers, its memory ledger) belongs in the **workspace overlay** — the shadow/catalog mechanism (`.clobber/prompt-modules/`, `.clobber/skills/`, the workspace's own role pins) — **never baked into the default**. Before adding content to a default surface, ask: *would this serve a stranger's clobber workspace?* If not, it goes in the overlay. The overlay mechanisms are the very seams GR3 promises; enforced at the merge juncture by the `merge-gate` skill's SEAM check.

**Application discipline:**

- **Re-use audit before every PR.** Before scaffolding a new component / service / route, scan the codebase for an existing one to generalize. If you find one, fold the extraction into the current work or file a separate issue if the extraction is heavier than the feature itself.
- **Raise non-conforming code we touch.** Threshold is *refactor cost*, not violation severity. Trivial inline fixups: roll in silently but gesture to them in the end-of-turn summary. Heavier refactors: ask the human whether to fold in or file a separate work item.
- **Blue-sky privately, surface selectively.** Run the reframe to yourself first. If at least one alternative is genuinely interesting — re-shapes the feature, opens up a primitive, eliminates a category of future work — surface it to the human before logging the narrative. Otherwise stay quiet.
- **Codify everything via skills / runbooks / issues.** Disconnected sessions stay aligned only when the rules live in durable, agent-discoverable surfaces. If a pattern is worth doing twice, it's worth codifying once.

## Engineering Rules

These mirror what works in adjacent projects. They are the non-negotiable mechanics that implement the Golden Rules above.

1. **TDD mandatory.** Failing test first, then implement. Integration tests over unit tests — write full-flow tests, not isolated function tests. No unit tests unless the user explicitly approves in a comment naming them. A test, fix, or gate that passes without exercising the real failing path is inert — prove it on the real path (a populated DB, the actual route, the live flag), not a synthetic proxy.
2. **Test timeouts are bugs.** Never increase a timeout to make a test pass. Find the underlying async issue.
3. **No defensive programming.** No null checks, no `??`/`||` defaults, no swallowing errors. Unexpected data → throw. Defaults hide bugs. Only exception: comment with the user's name explicitly approving a defensive check.
4. **Files ≤ 300 lines.** Split by responsibility when crossing.
5. **No duplicated code.** Extract shared logic to a sensible place.
6. **No deprecated/legacy comments.** Replace, don't accumulate. If you remove code, just remove it — no "this used to be X" notes.
7. **Quality over speed.** No time pressure. Choose the maintainable approach.
8. **Forward-only.** Don't worry about backwards compatibility unless it's load-bearing.
9. **Type safety as DX.** Use mapped, conditional, generic, and `infer` types where they make autocomplete and correctness fall out naturally. The goal: the developer feels guided by the types. Type-check is a load-bearing correctness gate, not a formality: a type error is a design finding, and a change isn't done until `type-check` is clean.
10. **Comments explain why, not what.** Good names beat comments. Default to no comments.
11. **Don't trust a stated count.** Failure counts, baselines, and inventories rot and are scope-relative. Establish ground truth yourself against the real source before attributing or acting on a number someone (or some doc) stated.

## Worktree Rule

Past the bootstrap commits, no work directly on `main`. Use `git worktree add` for non-trivial branches.

## Stack-Specific Notes

- Sessions are spawned with `--session-id <clobber-uuid>` so we control the ID and can resume/audit.
- The clobber-composed `appendSystemPrompt` is captured per wake on `sessions.composed_system_prompt` (distinct from the `role_versions.system_prompt` template) and re-captured on resume, so the transcript can surface what the agent was actually told. The `/sessions/:id/transcript` route prepends it as a leading `system-prompt` pseudo-line, rendered behind the transcript's "show details" toggle.
- Hook scripts POST to Clobber's local HTTP API. `CLOBBER_URL` and `CLOBBER_AGENT_ID` (and `CLOBBER_SESSION_ID`) are passed via env on spawn.
- `clobber ask "<question>"` blocks until the UI replies; the reply is printed to stdout for the agent to read.
- An agent's native `AskUserQuestion` tool call is intercepted via `PreToolUse` and routed through the same ask-widget pipeline (`packages/server/src/ask-user-question-bridge.ts`). Every role with `AskUserQuestion` in its tool list gets workspace-aware UX without per-role prompt surgery; `clobber ask` remains the explicit programmatic path.
- `clobber status "<message>"` and `clobber finding "<text>"` are fire-and-forget.
- Every user turn clobber synthesizes (wake-kick, trigger, ask-answer, spawn-prompt, live-inject, interrupt-notice) is wrapped at the serialize chokepoint (`serializeUserMessage` / `serializeUserPrompt`) in `<clobber type="X" [via="Y"]>…</clobber>`. Human composer turns pass no `kind` and stay bare — bareness is the positive presence signal. `type` is a fixed enum (`UserTurnKind` in `@clobber/shared`); `via` carries trigger-kind for `type="trigger"` so the enum stays small. The web transcript classifier (`classifyLine`) parses the tag structurally and renders tagged turns with a distinct amber badge so a scroll-back makes "what I typed" versus "what clobber injected" obvious at a glance. The agent-side interpretation half (#262) lives in `CLOBBER_TAG_INTERPRETATION_GUIDANCE` (in `@clobber/shared`'s `user-turn.ts`) and is prepended to every session's composed system prompt by `composeSystemPrompt`, so manager and worker both learn the wrapper's meaning without per-role prompt copy-paste.
- Roles are composed via `defineRole(manifest)`. The shipped `worker` role declares an `sdlc` profile (default: research → failing-test → implement → open-pr → watch-ci) that the system-prompt template renders dynamically; forks can override the profile to express a different workflow. `manager` is persistent with always-on triggers; `worker` is ephemeral and autonomous.

## Triggers

- v1 ships only **button** (user UI action).
- v2+ adds **cron**, **agent-to-agent events**, **GitHub webhooks**, **file watcher (desk)**, **external-session detected**.
- Trigger plumbing must be designed so adding a new kind is additive — no rewrites.

## What NOT to Do

1. Don't kill processes on ports > 3500.
2. Don't write unit tests without approval.
3. Don't add defensive null/error handling.
4. Don't commit `.env`, secrets, or anything in `.clobber/`.
5. **Generated-subtree rule.** `docs/{cli,permissions,roles}/`, `docs/index.md`, and `docs/CHANGELOG.md` are machine-generated — never hand-edit them. They are projected from in-code single-sources (`CLI_CAPABILITY_REGISTRY`, `buildCommandRegistry()`, role manifests, `git log`) by the `docs:gen` script (`bun run docs:gen`). If documentation needs updating, change the source; the generator produces the output. The gate fails on drift: `bun run docs:gen && git diff --exit-code`. Hand-authored docs (e.g. `docs/architecture/`) are allowed and not touched by the generator. AI assistants must never hand-roll prose docs for the generated subtree.
6. Don't leave deprecated/legacy code or "removed because…" comments.
