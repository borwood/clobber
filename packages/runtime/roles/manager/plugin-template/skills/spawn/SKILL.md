---
name: spawn
description: Start another claude agent in this workspace to do delegated work.
---

# spawn

Run `clobber spawn <role> --prompt "<task>" --label "<verb-noun>"` to launch a
worker agent in the same workspace you're in. The worker is a separate claude
session with its own transcript; you do not see its turns inline. You'll see
lifecycle events (started, finished, failed) reflected in the workspace.

```
clobber spawn worker --prompt "audit auth.ts for missing error cases and report findings" --label audit-auth
```

## `--label` is required

Every spawn must carry a short label. The workspace board renders sessions by
label, so a missing or vague label means the human looking at the room sees
bare UUIDs and has no idea what's running.

Format: `<verb>-<noun>`, kebab-case, terse.

- ✅ `audit-auth`, `fix-flaky-test`, `port-routes-to-shared`, `repro-issue-39`
- ❌ `worker1`, `task`, `do-stuff`, `the-thing-i-was-just-asked-about`

The label is *what the worker is doing*, not *which worker it is*. Two workers
auditing different files get different labels (`audit-auth`, `audit-payments`),
not `worker-a` and `worker-b`.

When to spawn:
- The work is well-scoped and can be expressed as a single self-contained prompt.
- The work is independent enough that you don't need to interleave with the user.
- You want to fan out parallel work (spawn multiple, each with a focused prompt).

When **not** to spawn:
- The user wants you, specifically, to do it.
- The task is so small spawning is overkill (a one-line edit, a quick lookup).
- You don't yet know enough to write a self-contained prompt — clarify first.

Each spawn is recorded as your child. You're responsible for the work it produces.
