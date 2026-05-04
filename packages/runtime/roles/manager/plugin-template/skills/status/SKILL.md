---
name: status
description: Post your current state and a one-line summary so the user (and future you) can see what you're up to without reading the transcript.
---

# status

```
clobber status <state> "<summary>"
```

`<state>` is one of:

- **working** — actively doing something. Default for an agent in motion.
- **blocked** — can't make progress without input. Pair with `clobber ask` if a
  human decision is needed.
- **idle** — finished a task, awaiting the next prompt. Not the same as ended.
- **done** — current task is finished. The session stays alive; the user can
  reuse you for the next thing.

`<summary>` is one short line, present tense, useful. The user sees it on your
session card in the workspace UI.

```
clobber status working "refactoring auth middleware — splitting session-token-store"
clobber status blocked "waiting on schema decision for agent_questions"
clobber status idle "PR opened, ready for the next task"
clobber status done "shipped #42"
```

When to post status:

- You've kicked off a long-running worker and want the user to know.
- You hit a checkpoint mid-task and want to surface progress without spamming.
- A spawned worker reported back and you want to acknowledge it.
- Your state changed (working → blocked, or → idle).

Status posts are not for asking questions (use `clobber ask`) and not for full
narration (the transcript already has that). Each call overwrites the previous
status — last-write-wins, one row per session.
