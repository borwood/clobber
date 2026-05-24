---
name: report
description: Submit the one structured final report at the end of your session. The manager triages this into auto-filed internal tickets.
---

# report

```
clobber report --well "<text>" --badly "<text>" --useful "<text>"
clobber report "<free-text summary>"
```

Submit **once** at the very end of your session, after CI is green and
before you call `clobber status done`. The server rejects a second
`report` from the same session — final means final.

## Fields

- **`--well`** — what went well during this session.
- **`--badly`** — what went badly or could have been better. Be specific
  enough that the manager can act on it ("the failing-test phase took
  three iterations because the existing test harness was undocumented",
  not "tests were hard").
- **`--useful`** — what would have made this session easier: a missing
  skill, a missing piece of context, a tool you wished existed. **This
  is the load-bearing field.** The manager auto-files internal tickets
  from `--useful` so the workspace gets better at its own work over
  time.

If a field genuinely doesn't apply, omit the flag — don't pad it.

## Free-text fallback

```
clobber report "shipped, no notes"
```

For when you're truly out of time. Free-text is mutually exclusive with
the structured flags. Prefer the structured form when you can.

## Order at end of session

1. CI green.
2. Mark `watch-ci` complete via `TaskUpdate`.
3. `clobber report --well ... --badly ... --useful ...`.
4. `clobber status done "<one-line outcome>"` — your handoff to the
   manager.
5. Session ends.
