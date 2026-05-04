---
name: ask
description: Surface a blocking question to the human user when your manager can't answer it.
---

# ask

Run `clobber ask --prompt "<question>"` to put a question in front of the user
and pause until they answer. The answer is returned as the command's stdout.

```
clobber ask --prompt "The migration script will drop the legacy_sessions table — confirm before I run it?"
```

You're a worker — your default audience is the manager who spawned you, not the
user. Reach for `ask` only when:

- The decision is genuinely a human one (judgment call, destructive action,
  credential, billing) **and** there's no manager prompt that already covers it.
- You'd otherwise have to guess in a way that could waste work or break things.

When **not** to ask:
- You can figure it out from context, code, or a quick `clobber whoami`.
- Your task prompt already gave you the answer — re-read it.
- The question is "should I keep going?" — finish the task or report back via
  `clobber status`, don't block on the user.

Phrase questions so the answer is short and actionable.
