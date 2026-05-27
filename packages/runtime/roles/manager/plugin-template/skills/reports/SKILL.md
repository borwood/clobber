---
name: reports
description: Read worker final reports for your workspace and triage each one — ticket, wisdom-capture, or nothing.
---

# reports

`clobber reports` is your triage surface for worker final reports. Every worker
submits one structured report at the end of its session (what went well, what
went badly, what would have been useful). Those reports persist to the DB
(`agent_status_log`, `kind=final-report`) — **the DB is the system of record**,
not a GitHub issue. This command reads them.

```
clobber reports list                 # recent reports, newest first
clobber reports show <session-id>     # the full well/badly/useful for one
```

`list` gives you session id, role, label, state, one-line summary, timestamp.
`show <session-id>` gives the full structured body. Both take `--json`.
Workspace-scoped: you only see reports from your own workspace, and they
survive the reaper deleting the ephemeral worker that wrote them.

You are usually woken **with** a worker's done-summary when it declares
`status done` (the worker-done trigger, #240) — workers idle after opening a PR
rather than ending, so this is the happy-path wake. The wake carries the
one-line summary; use `reports show <session-id>` to read the worker's full
final-report body, and `reports list` to see it among recent finishes. A worker
that crashes/kills instead wakes you via the session-ended trigger (#171).

## Triage: the only three outcomes

Reading a report is not the work — **deciding what it means is**. Every report
resolves to exactly one of:

1. **Nothing.** The default. "Shipped, no notes," "tests landed clean,"
   "went fine." Most reports are this. Reading it and moving on **is** the
   correct handling — the report already lives in the DB if you ever need it.
   Do not file anything.

2. **Wisdom-capture** (`manager:wisdom-capture`). The report names a *behavioral*
   pattern — something about how workers work that should change how you brief
   or design roles. "Spent too long re-reading the issue because the assignment
   buried the acceptance criteria" → a briefing-shape lesson. Capture the
   durable lesson, not the one-off.

3. **A ticket** (`gh issue create` against this repo). The report names a
   concrete, actionable *engineering* gap: a missing skill, a broken runbook
   step, a flaky harness, a tool that should exist. File it with the source
   session id so the gap is traceable. One ticket per real gap — not one per
   finish.

## What NOT to do

- **Don't blanket-file.** One issue per worker finish was explicitly rejected as
  noise (#196). The report is already recorded; filing is for the actionable
  minority.
- **Don't auto-file by heuristic.** There is no "notable report" filter in the
  engine on purpose — triage is your judgment, not a rule. A terse "went badly"
  with no specifics is a prompt to read the transcript (`clobber transcript`),
  not to file.
- **Don't confuse `badly` with `ticket`.** "Badly" is the worker's experience;
  whether it becomes a ticket depends on whether *you* can act on it. Many
  "badly" notes resolve to wisdom-capture or nothing.

## When a report is thin

A one-word or vague report on a session that clearly went sideways is itself a
signal. Pull the transcript (`clobber transcript <session-id>`) to see what
actually happened before deciding the outcome — the report is the worker's
summary, the transcript is the ground truth.
