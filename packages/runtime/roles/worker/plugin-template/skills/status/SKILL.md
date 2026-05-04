---
name: status
description: Report progress and the final outcome to the manager and user.
---

# status

`clobber status --post "<message>"` pushes a one-line update onto the workspace
timeline. The user and your manager see these without having to read your full
transcript.

```
clobber status --post "ran the migration on staging — 0 rows changed, looking at why"
```

As a worker, you should post status:

- **At the start**, once you understand the task: "starting on X, plan is Y."
- **At checkpoints** during long-running work: "finished step 1, moving to step 2."
- **At the end**, summarizing the outcome: "done — added route + 4 tests, all
  passing." This is your handoff back to the manager.

You can also run `clobber status` with no flags to print every agent currently
alive in the workspace. You won't usually need to — the manager owns
orchestration — but it's there if you need to confirm context.

Status posts are not for asking questions (use `clobber ask`) and not for full
narration (the transcript already has that). One line, present tense, useful.
