---
name: ask
description: Surface a blocking question to the human user and wait for an answer.
---

# ask

Run `clobber ask "<question>"` to put a question in front of the user and
pause until they answer. The answer is returned as the command's stdout.

```
clobber ask "Should I delete the deprecated /v1 endpoint, or keep it under a deprecation header for one more release?"
```

If the answer is one of a small fixed set, pass each choice as a `--option`
flag — the web ask widget renders them as buttons:

```
clobber ask "merge or rebase?" --option merge --option rebase
```

When to ask:
- A genuine judgment call only the user can make (product decision, scope cut,
  rollback vs. forward-fix).
- A destructive action you want explicit consent for (deleting data, force-pushing,
  paying money).
- A credential or secret you cannot derive yourself.

When **not** to ask:
- You can figure it out from context, code, or a quick `clobber whoami` /
  `clobber status`.
- You're stalling because the task is hard. Try first; ask if you genuinely block.
- A worker could investigate the question — spawn one instead.

Phrase questions so the answer is short and actionable. Multi-paragraph essays
are not questions, they're status reports — use `clobber status` for those.
