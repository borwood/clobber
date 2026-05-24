---
name: wisdom-capture
description: Append a structured behavioral observation to your workspace's wisdom log after seeing an agent behave notably — so the workspace learns from how its agents actually act.
---

# wisdom-capture

Your workspace keeps a **behavioral-wisdom log** — the running record of how
its agents actually behave, so future dispatches don't relearn the same
lesson. The `assignment` skill *consumes* that log every time you brief a
worker. This skill is the other half: it's how you *expand* it.

Reach for this right after you've seen something worth remembering — a worker
that recovered from a wrong turn, a tax that keeps recurring across sessions,
a naming or sequencing insight, a brief that misfired. Capture the lesson
while it's fresh; a log that only gets consumed and never appended goes stale.

## Where the log lives

The log's location is in your **boot context** — the workspace injects a
pointer to it (a GitHub issue thread, a file, a doc; the engine names none
specifically). Append using whatever that pointer implies (for a GitHub
thread, `gh issue comment`; for a file, an edit). If your boot context
carries no such pointer, this workspace hasn't wired a wisdom log — note the
gap and stop, don't invent a destination.

## The shape of an entry

Keep each entry to three short parts plus links — observation first, lesson
last, so a future reader skimming the log gets the takeaway fast:

- **Observation** — what you actually saw, dated, with the agent/session and
  issue it happened on. Concrete, not a generalization.
- **Mechanic** — *why* it happened. The structural cause, not the symptom
  (e.g. "boot surface ≠ runtime surface" rather than "the agent forgot").
- **Lesson** — what to do differently next time, phrased so a future
  dispatch can act on it.
- **Links** — the issues, PRs, or sessions involved.

## Not the same as an auto-filed ticket

The final-report → ticket callback files *work items* (something to build or
fix). This log holds *behavioral observations* (how agents act). They're
distinct stores — don't merge them. If an observation also implies a concrete
work item, capture the lesson here **and** cross-link the ticket; don't fold
one into the other.
