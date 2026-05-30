---
name: message
description: Send a note to a running worker mid-session and hand it a single-use token to reply with. Manager-only — workers cannot initiate.
---

# message

Talk to a worker that's already running — nudge it, ask whether it checked
something, or course-correct without ending and re-spawning it.

```
clobber message <agent-id> "<text>"
```

```
clobber agents list                       # find the worker's agent_id
clobber message 7f3a… "did you check the schema migration before debugging the test?"
```

The worker's next turn carries your note as
`<clobber type="message" from="<you>" token="<token>">…</clobber>`. The response
prints `{ message_id, token, sent_at }` — the same `token` is embedded in the
worker's inbound payload as a **single-use reply capability**.

How the thread behaves:

- **The worker can reply at most once**, with `clobber reply <token>`. Its answer
  arrives back on you as a `<clobber type="message-reply">` turn. To continue the
  exchange, message again — each `message` mints a fresh token.
- **Delivery is safe mid-turn.** If the worker is busy, the note is held and
  delivered at its next turn boundary; you don't manage timing.
- **It's fire-and-forget.** You don't block waiting for a reply. Poll
  `clobber transcript` or `clobber agents` if you want to see what happened.
- **Scope.** Same workspace only; a recipient whose session has ended returns a
  gone error. Only persistent agents (you) can initiate — this asymmetry is the
  point: every reply is anchored to a thread you opened.

Reach for `message` when a worker is mid-flight and you have a small, specific
steer. For opening *new* work, use `/assignment`; for a teardown, `clobber kill`.
