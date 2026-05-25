---
name: resume
description: Bring an ended agent session back in this workspace.
---

# resume

`clobber resume <session-id>` revives an ended session: it respawns the
runtime against the session's existing conversation thread (`claude --resume`)
and re-registers it, so the agent comes back **with the same role version,
worktree, and desk it had before**. It's the symmetric counterpart to
`clobber kill`. Workspace-scoped: you can only resume sessions in your own
workspace.

```
clobber resume <session-id> [--prompt "<follow-up directive>"]
```

Get a `<session-id>` from `clobber agents list` (or the workspace sidebar —
ended sessions flagged "was live" were running when clobber last closed and
have unfinished business).

## When to resume (versus spawning fresh)

- ✅ A worker exited cleanly but you disagree with where it stopped — revive it
  with a `--prompt` correcting course ("the test you wrote was wrong, try
  again").
- ✅ A worker ended mid-task without flagging `done`, and its worktree holds
  real in-progress work you don't want to recreate.
- ✅ Picking a session back up after a restart (it kept its conversation via
  `--resume`).
- ❌ The task has materially changed — spawn a fresh worker with a clean brief
  instead; resume drags the old conversation along.
- ❌ The session never really started (no useful history to continue).

## How it behaves

- `--prompt` is **optional**: bare resume continues the conversation cleanly;
  with a prompt, the directive is delivered as the next turn.
- The **pinned role version is preserved** — the agent returns with the exact
  skills/prompt/tools it had, not whatever the role's current version is now.
- **Re-checks the workspace role ceiling** before reviving (same 403 as spawn):
  a revived session re-occupies a slot, so free one first if you're at cap.
- Returns the new `pid` and the (unchanged) `session_id`.

## Notes

- Resuming a session that is still active returns `409` — use
  `clobber kill` first if you mean to restart it.
- Reviving a worker that already submitted a final report is allowed (you may
  disagree with the report); the prior report stays in the audit log.
