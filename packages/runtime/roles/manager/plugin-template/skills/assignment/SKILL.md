---
name: assignment
description: Spawn a worker for one or more GitHub issues with a structured briefing packet on its desk.
---

# assignment

`/assignment <issue#> [<issue#>...] [<additional-notes>]` is your lever for
turning *"this issue is ready"* into *"a worker is now embodied at a desk,
working on it."* Read this skill before invoking — getting the briefing right
is what makes the worker actually finish unattended.

The assignment is a single worker per call, even when you bundle multiple
issues. Bundle issues only when they're tightly coupled (same module, same
PR's blast radius). Otherwise, run `/assignment` once per issue.

## Steps you take

1. **Fetch the issue(s).**

   ```
   gh issue view <n> --repo <owner>/<repo> --json title,body,labels,assignees,comments
   ```

   Read the body. Look for `## Why`, `## Proposal`, `## Acceptance`,
   `## Open questions`, `## Out of scope` — clobber-style issue conventions.
   If `## Open questions` has unresolved entries that would gate the
   implementation, **stop and `/clobber-pm note` (or just `clobber ask`) the
   user instead of spawning** — the worker can't answer design questions.

2. **Decompose into a phase plan.**

   For a code repo the worker role's default `sdlc` profile ships these
   phases: `research → failing-test → implement → open-pr → watch-ci`. Use
   them unless the issue body explicitly redefines the workflow, or the
   worker's role has been forked with a different `sdlc` profile. Compose
   the plan as a JSON array shaped for `TodoWrite`:

   ```json
   [
     { "content": "research: read #82 + linked PRs + db.ts", "status": "in_progress", "activeForm": "researching #82" },
     { "content": "failing-test: pin the WAL-pragma comment expectation", "status": "pending", "activeForm": "writing failing test" },
     { "content": "implement: add the comment and run the suite",         "status": "pending", "activeForm": "implementing" },
     { "content": "open-pr: branch, commit, push, gh pr create",         "status": "pending", "activeForm": "opening PR" },
     { "content": "watch-ci: poll checks, fix on red",                    "status": "pending", "activeForm": "watching CI" }
   ]
   ```

   The first item starts `in_progress`; the rest start `pending`. Keep each
   `content` short — phase + one-line specific intent. The worker will read
   this from disk on its first turn and call `TodoWrite` with it.

3. **Compose the briefing packet** — a small directory of files. Standard
   layout:

   ```
   /tmp/briefing-<label>/
     seed-todos.json         # the JSON array above
     assignment.md           # human-readable summary of the issue + your notes
     context.md              # OPTIONAL: workspace conventions, prior decisions
   ```

   `assignment.md` should distill the issue's `## Why` and `## Acceptance`
   plus any `<additional-notes>` you were given when invoked. Keep it short
   — a worker that reads 800 lines of preamble has lost half its context
   budget before it starts. One screen is the goal.

   `context.md` is for things the worker *won't infer from the repo*:
   workspace branch naming, commit message style, special CI gates, prior
   PR's worth referencing. Skip it if the repo's `CLAUDE.md` already covers
   what the worker needs.

4. **Spawn the worker.**

   ```
   clobber spawn worker \
     --prompt "ship issue #<n> end-to-end; full brief on your desk" \
     --label "<verb-noun>" \
     --briefing-dir /tmp/briefing-<label>
   ```

   The label follows `manager:spawn` conventions (`fix-flaky-test`,
   `audit-auth`, `issue-82`). The briefing-dir contents land at
   `.clobber/agents/<the-worker's-agent-id>/desk/` before the worker takes
   its first turn; the worker system prompt instructs it to read every
   file there as its first action.

5. **Status emit.** After the spawn returns, post one `clobber note`
   summarizing what you dispatched and to which session — the audit trail
   for the workspace board.

## Bundling multiple issues

When invoked as `/assignment #65 #66 ...`, build *one* combined briefing
packet: a single `seed-todos.json` that walks both issues in dep order,
and an `assignment.md` whose top section frames *why these issues belong
together* and whose body has one section per issue. The worker spawns
once, walks the combined plan, opens one PR that closes both.

## When to refuse

If any of the following is true, write a `clobber note` explaining why and
**don't spawn**:

- The issue is missing `## Acceptance` and you can't infer one.
- Two assigned issues conflict with each other or with a recent decision in
  the roadmap.
- The issue is gated on infrastructure that doesn't exist yet (e.g., the PR
  needs an endpoint that hasn't been written).

A failed dispatch is louder than a confused worker.
