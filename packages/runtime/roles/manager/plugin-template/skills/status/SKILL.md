---
name: status
description: Report progress to the user and/or inspect the workspace's live agents.
---

# status

Two uses, one command.

**1. Inspect the workspace.** Run `clobber status` with no flags to print every
agent currently alive in this workspace, with their roles, parent links, and how
long they've been running.

```
clobber status
```

**2. Report your own progress.** Run `clobber status --post "<message>"` to
push a one-line status update onto the workspace timeline. The user sees these
in their UI without you having to interrupt your own turn.

```
clobber status --post "ran the migration on staging — 0 rows changed, looking at why"
```

When to post status:
- You've kicked off a long-running worker and want the user to know.
- You hit a checkpoint mid-task and want to surface progress.
- A spawned worker reported back and you want to acknowledge it before continuing.

Status posts are not for asking questions (use `clobber ask`) and not for full
narration (the transcript already has that). One line, present tense, useful.
