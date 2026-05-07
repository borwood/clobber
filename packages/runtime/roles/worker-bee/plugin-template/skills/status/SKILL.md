---
name: status
description: Post your current state and a one-line summary so the manager and user can see what you're doing without reading your full transcript.
---

# status

```
clobber status <state> "<summary>"
```

`<state>` is one of:

- **working** — actively doing the task. This is your default while in motion.
- **blocked** — can't make progress without input. Pair with `clobber ask` if
  you genuinely need a human decision.
- **done** — your task is finished. Pair this with one final summary line; the
  manager picks up from there.

`<summary>` is one short line, present tense, useful.

```
clobber status working "running migration on staging"
clobber status blocked "can't decide between approach A and B — see clobber ask"
clobber status done "added the route + 4 tests, all passing"
```

As a worker, post status:

- **At the start**, once you understand the task: "starting on X, plan is Y."
- **At checkpoints** during long-running work: "finished step 1, moving to 2."
- **At the end**, summarizing the outcome: this is your handoff back to the
  manager.

Status posts are not for asking questions (use `clobber ask`) and not for full
narration (the transcript already has that). Each call overwrites the previous
status — last-write-wins, one row per session.
