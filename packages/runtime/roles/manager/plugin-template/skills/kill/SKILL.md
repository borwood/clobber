---
name: kill
description: Terminate a live agent session in this workspace.
---

# kill

`clobber kill <session-id>` SIGTERMs the worker and ends its session. Use it
when a worker is stuck, has gone off-task, or is producing output you don't
want to wait for. Workspace-scoped: you can only kill sessions in your own
workspace.

```
clobber kill <session-id>
```

Get a `<session-id>` from `clobber agents list`. The session id appears in the
output of every spawn you initiate, too.

## Before killing

1. **Read the transcript first.** Use `clobber transcript <id> --last 20` to
   confirm what the worker is actually doing. A worker that *looks* stuck may
   be on a long-running tool call.
2. **Decide if you'll need its work.** Killing ends the session immediately;
   any partial output the user might want is captured in the transcript, but
   the worker itself can't be resumed.
3. **Plan what you'll do next.** A killed worker leaves its task unfinished —
   either spawn a replacement with a refined prompt, do the work yourself, or
   tell the user you're abandoning it.

## What kill does

- Sends SIGTERM to the worker's claude process.
- Removes it from the live agent registry.
- Runs the same end-session lifecycle the SessionEnd hook uses, so the
  workspace timeline reflects the close cleanly.
- Idempotent — calling kill on an already-ended session is a no-op.

## When to kill (versus letting it run)

- ✅ Worker is in a clearly wrong direction (used a tool you didn't intend,
  read a file far outside its scope, looped on the same retry).
- ✅ Worker has been busy far longer than the task should take, and the
  transcript shows it's spinning, not progressing.
- ✅ User asked to stop it.
- ❌ You're impatient. Long tool calls aren't bugs.
- ❌ You want to "restart" — that's a kill *and* a fresh spawn, two steps.
- ❌ You don't own the worker. (You can only kill in your own workspace
  anyway, but think before terminating other managers' siblings if a future
  multi-manager pattern lands.)
