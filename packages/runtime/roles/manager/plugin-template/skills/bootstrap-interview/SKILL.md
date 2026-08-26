---
name: bootstrap-interview
description: First-open interview that turns a fresh workspace into a coherent one — writes the shared-context overlay every future session (yours and every worker's) reads.
---

# bootstrap-interview

You were woken because this workspace has no `.clobber/bootstrap.json`
sentinel yet — this is (as far as the engine can tell) the first time anyone
has opened it. Your job: interview the human once, short, and turn their
answers into the overlay files the engine already knows how to read. Nothing
here invents a new mechanism — you're writing a prompt-module and a role
ref, the same surfaces `/assignment` and every other skill on this role
already rely on.

## The interview

Ask all four areas in **one** `AskUserQuestion` call (it supports multiple
questions per call — don't spread this across several round-trips):

1. **Repo shape / stack.** What is this repo, and what's the stack? (language,
   framework, monorepo-or-not, anything a new agent would otherwise have to
   grep for on its first task.)
2. **SDLC phases.** What phases does this team want work to move through
   before it's done? Offer the shipped worker default
   (`research → failing-test → implement → open-pr → watch-ci`) as one option,
   plus free text for a different shape.
3. **Which shipped roles to enable, and at what ceiling.** Offer the shipped
   roles as options (at minimum `manager`, `worker`) with a free-text path for
   "also disable X" or a specific ceiling count.
4. **Hazards / conventions / always-true facts.** Free text. Anything a new
   agent working this repo should be told once instead of rediscovering —
   a footgun, a naming convention, a "we always X" rule.

If the human declines or aborts the interview (skips the widget, says "not
now"), **stop here — write nothing**. A half-answered interview must not
leave a partial overlay; the workspace stays on shipped defaults and the
sentinel's absence means you'll be asked again next open.

## Writing the answers (in this order)

Order matters: the sentinel is the durable "this workspace is bootstrapped"
signal, so it's the *last* thing you write. If you're interrupted after step 1
but before step 3, the workspace is still in a clean pre-interview state next
time you're woken.

1. **Role ceilings**, if the human wants any shipped role disabled or
   re-ceilinged: `clobber roles ceiling <role> <max>` (0 disables it).
2. **The shared-context module.** Compose the four answers into one static
   prompt-module and create it:

   ```
   clobber prompt-modules create project-context --static -
   ```

   (pipe the composed text to stdin). Structure the text as short sections —
   `## Repo` / `## Ratified SDLC` / `## Roles` / `## Conventions & hazards` —
   so it reads well composed into any session's system prompt. This is v1's
   "user-ratified SDLC satisfied by construction": the phases are documented
   here so every session sees them, not re-derived from the worker role's
   shipped default.
3. **Wire it onto the worker role**, so every worker spawned from now on
   carries it:

   ```
   clobber roles prompt-modules worker add project-context
   ```
4. **The sentinel, last.** Write `.clobber/bootstrap.json` in the workspace
   repo root:

   ```json
   { "done": true, "answered_at": "<ISO timestamp>", "answers": { "repo": "...", "sdlc": "...", "roles": "...", "hazards": "..." } }
   ```

   This file's mere *existence* is what stops the interview from re-firing on
   the next `workspace-open` wake — its content is audit trail, not something
   anything else parses.

## Amending later

There is no re-interview flow in v1. If the human wants to redo it, delete
`.clobber/bootstrap.json` — the next workspace open re-offers the interview.
Editing `.clobber/prompt-modules/project-context/prompt-module.json` directly
(or via `clobber prompt-modules edit`) works too, any time, sentinel or not.
