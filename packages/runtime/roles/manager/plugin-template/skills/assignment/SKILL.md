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
   implementation, **stop and `clobber ask` the user instead of spawning**
   — the worker can't answer design questions.

2. **Decompose into a phase plan.**

   For a code repo the worker role's default `sdlc` profile ships these
   phases: `research → failing-test → implement → open-pr → watch-ci`. Use
   them unless the issue body explicitly redefines the workflow, or the
   worker's role has been forked with a different `sdlc` profile. Compose
   the plan as a tool-agnostic JSON array of phases (`content` / `status` /
   `activeForm` per entry):

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
   `content` short — phase + one-line specific intent. The worker reads this
   from disk on its first turn and translates it into whichever task tool its
   harness exposes — a single `TodoWrite` call, or one `TaskCreate` per phase
   then `TaskUpdate` the first to `in_progress` for the `Task*` family. Keep
   the seed itself plain phase data and name no specific tool here; the worker
   adapts it to whatever its harness surfaces.

3. **Consult your workspace's wisdom log.** Before you compose the brief,
   read your workspace's behavioral-wisdom log for prior findings that bear
   on *this* dispatch — how a worker on a similar issue went sideways, a
   recurring tax to pre-empt, a sequencing or naming insight worth passing
   on. Its location is in your **boot context** (the workspace injects a
   pointer there; the engine itself names no specific log). Surface only the
   findings relevant to this assignment, and fold them into the brief — a
   one-line "watch out for X, the log notes Y" in `assignment.md` is enough.
   This consult is structural: you do it *every* time you brief, by
   construction, not when you remember to. If your boot context carries no
   such pointer, this workspace hasn't wired a wisdom log — skip the step.

4. **Compose the briefing packet** — a small directory of files. Standard
   layout:

   ```
   /tmp/briefing-<label>/
     boot-tasks.json         # the JSON array above
     assignment.md           # human-readable summary of the issue + your notes
     context.md              # OPTIONAL: workspace conventions, prior decisions
   ```

   `assignment.md` should distill the issue's `## Why` and `## Acceptance`
   plus any `<additional-notes>` you were given when invoked. Keep it short
   — a worker that reads 800 lines of preamble has lost half its context
   budget before it starts. One screen is the goal.

   - **Pin observable contract values.** Name any value the worker must not
     improvise — HTTP status codes (e.g. a 503 with a structured body vs. a
     generic 500), serialization format (compact vs. spaced JSON), exact
     error strings or shapes, on-disk or golden-file formats. An unmade
     decision in the brief is a coin-flip the worker pays for in a debug
     cycle.

   `context.md` is for things the worker *won't infer from the repo*:
   workspace branch naming, commit message style, special CI gates, prior
   PR's worth referencing. Skip it if the repo's `CLAUDE.md` already covers
   what the worker needs.

5. **Spawn the worker.**

   ```
   clobber spawn worker \
     --wake-program task \
     --prompt "ship issue #<n> end-to-end; full brief on your desk" \
     --label "<verb-noun>" \
     --briefing-dir /tmp/briefing-<label>
   ```

   The label follows `manager:spawn` conventions (`fix-flaky-test`,
   `audit-auth`, `issue-82`). `--wake-program task` is the worker's opening
   move: it composes the "read your desk, start the SDLC" protocol (layer C)
   and fires the kick. The briefing-dir contents land at
   `.clobber/agents/<the-worker's-agent-id>/desk/` before the worker takes
   its first turn; the `task` program instructs it to read every file there
   as its first action.

   **Tuning effort.** The worker role defaults to `--effort high`. The
   thesis is that *you* (the manager) carry the deep thinking — a tight
   brief + sound decomposition should leave the worker mostly executing.
   Override per-spawn with `--effort <low|medium|high|xhigh|max>` only
   when the assignment genuinely needs more (or less) reasoning depth:

   - `--effort max` when the brief is unavoidably underspecified or the
     work has a thorny invariant the worker must reason about live.
   - `--effort low` when the work is pure mechanical churn (rename, regex
     sweep, formatter pass).
   - Omit the flag otherwise and trust the role default.

   If you find yourself reaching for `max` often, the lever to pull is
   usually a better brief, not a deeper worker.

6. **Status emit.** After the spawn returns, post one `clobber status`
   summarizing what you dispatched and to which session — the audit trail
   for the workspace board.

## Bundling multiple issues

When invoked as `/assignment #65 #66 ...`, build *one* combined briefing
packet: a single `boot-tasks.json` that walks both issues in dep order,
and an `assignment.md` whose top section frames *why these issues belong
together* and whose body has one section per issue. The worker spawns
once, walks the combined plan, opens one PR that closes both.

**Split-issue PR linkage.** When a *single* issue is large enough to span
multiple PRs, brief the worker to write "Part of #X" (not "Closes #X") in
every PR but the last — "Closes #X" auto-closes the parent at the first
PR's merge. You (the manager) close the parent manually after the final PR
merges.

## When to refuse

If any of the following is true, write a `clobber finding` explaining why and
**don't spawn**:

- The issue is missing `## Acceptance` and you can't infer one.
- Two assigned issues conflict with each other or with a recent decision in
  the roadmap.
- The issue is gated on infrastructure that doesn't exist yet (e.g., the PR
  needs an endpoint that hasn't been written).

A failed dispatch is louder than a confused worker.
