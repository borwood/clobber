---
name: whoami
description: Confirm which clobber session, workspace, and role you are.
---

# whoami

Run `clobber whoami` to print your own identity as JSON. Useful at session start,
or any time you're unsure which workspace/role you're in.

```
clobber whoami
```

Output shape:

```json
{
  "session_id": "uuid",
  "workspace_id": "uuid",
  "role": { "id": "uuid", "name": "manager" },
  "started_at": 1700000000000
}
```

Use this when:
- The user asks "who are you?" or "what workspace is this?"
- You're about to spawn another agent and want to double-check your role allows it.
- You want to log your context at the start of a session.
