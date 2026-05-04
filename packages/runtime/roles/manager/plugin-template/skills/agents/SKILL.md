---
name: agents
description: List the live agents in this workspace, including yourself.
---

# agents

`clobber agents list` returns every active session in your workspace as JSON. You
appear in the list yourself, marked `is_caller: true` — useful when you're
auditing the org chart and want to ground "where am I" before investigating
others.

```
clobber agents list
```

Each entry includes:

- `session_id` — opaque id you pass to `clobber transcript` and `clobber kill`
- `agent_id` — the persistent agent row (same value across re-spawns of a
  persistent role)
- `role: { id, name }` — what role the session is running under
- `label` — optional human-friendly label set at spawn time
- `pid` — OS pid of the underlying claude process
- `state: "busy" | "idle"` — busy until the session's most recent turn ends
- `started_at` — Unix epoch ms
- `is_caller` — `true` for your own session, `false` for everyone else

When to use:

- Before spawning more workers — check who's already running, don't double up.
- Before investigating a complaint — find the session id of the worker the user
  is asking about.
- Before killing — confirm the target is actually live and that it's yours to
  kill (it must be in your workspace).

Pair with `clobber transcript <session-id>` to actually look at what a worker is
doing. The agents list answers "who is running"; the transcript answers "what
are they doing."
