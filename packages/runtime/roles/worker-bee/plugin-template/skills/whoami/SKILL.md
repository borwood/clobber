---
name: whoami
description: Confirm which clobber session, workspace, and role you are.
---

# whoami

Run `clobber whoami` to print your own identity as JSON. Useful at the very
start of your session to ground yourself before you start the task.

```
clobber whoami
```

Output shape:

```json
{
  "session_id": "uuid",
  "workspace_id": "uuid",
  "role": { "id": "uuid", "name": "worker" },
  "started_at": 1700000000000
}
```

Use this when:
- Starting your session, to confirm you're in the workspace you expect.
- Debugging — if a tool fails, your role + workspace context is the first
  thing the manager will ask about.
