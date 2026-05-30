---
name: reply
description: Answer a message your manager sent you, exactly once, using the single-use token it handed you in the inbound message.
---

# reply

When your manager messages you mid-session, the turn arrives wrapped as
`<clobber type="message" from="<manager>" token="<token>">…</clobber>`. The
`token` is a **single-use reply capability**. If you have something to say back,
redeem it:

```
clobber reply <token> "<your answer>"
```

```
clobber reply ab12cd34ef "yes — I ran the migration against staging first, it was clean"
```

The reply lands as one turn on the manager that opened the thread. That's it:

- **One reply per token.** The token is spent after one use; a second
  `clobber reply` with the same token fails. To continue the exchange, wait for
  the manager to message you again (it gets a fresh token each time).
- **Replying is optional.** A `message` turn is context, not a command. If it
  doesn't need an answer, just absorb it and carry on — don't reply for the sake
  of replying.
- **You can't initiate.** There is no `clobber message` for you; a worker only
  ever answers a thread the manager opened. If you need a *human* decision, use
  `clobber ask`. If you just need to report progress, use `clobber status`.

Keep replies short and to the point — the manager is triaging several agents.
