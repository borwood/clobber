---
name: notify.ack
description: Acknowledge a notification by ID so it no longer appears in your inbox.
---

# notify.ack

```
clobber notify ack <id>
```

Marks a notification as acknowledged (idempotent). Use this after acting on a
notification from `clobber notify list`.

```
clobber notify ack 3fa85f64-5717-4562-b3fc-2c963f66afa6
```

See `clobber notify --help` for full details.
