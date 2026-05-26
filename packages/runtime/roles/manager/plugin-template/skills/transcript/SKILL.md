---
name: transcript
description: Read the transcript of any session in your workspace, with selectors and detail levels.
---

# transcript

`clobber transcript <session-id>` is your investigation tool. You're a role
engineer, not just an operator — you study how workers behave to add skills,
troubleshoot bad runs, and audit work you spawned. Use it freely; transcripts
are the raw material of role design.

```
clobber transcript <session-id> [selector] [--grep <pattern>] [--detail low|medium|full] [--format text|json]
```

Get a `<session-id>` from `clobber agents list`. Workspace-scoped: you can only
read transcripts for sessions in your own workspace.

## Selectors (pick one)

| Flag | Meaning |
|---|---|
| (none) | Last 20 entries — quick orientation. |
| `--last N` | Last N entries. |
| `--entry <id>` | Single entry by id. |
| `--from <id> [--limit N]` | Slice forward from `<id>`, up to N entries (default 20). |
| `--to <id> [--limit N]` | Slice backward ending at `<id>`, up to N entries (default 20). |

Entry ids are stable per-snapshot integer indices ("0", "1", "2", …). They're
echoed in every entry so you can drill in: see something interesting at
`[37] [tool_use Bash] rm -rf node_modules`, then `--entry 37 --detail full` to
see the full payload.

## Detail levels

| Level | Shows |
|---|---|
| `low` | Only message turns (user / assistant text). For "what was actually said." |
| `medium` (default) | Messages plus one-line summaries of events between them. |
| `full` | Raw stream-json payloads. Use when you need exact tool inputs/results. |

## Search (`--grep`)

`--grep <pattern>` keeps only entries whose **rendered content matches** the
regex — the same text you'd see at the active `--detail` level (tool-use
command strings, assistant/user text, event summaries, or raw payload at
`full`). Each surviving entry keeps its **id** and role/kind, so you can drill
in afterward. This replaces the old `clobber transcript … | grep` fallback,
which threw away ids and structure.

- **Case-insensitive by default**; add `--case-sensitive` to opt in.
- `-C, --context <n>` includes ±N surrounding entries per match.
- **Composes with selectors** — a bare `--grep` searches the *whole*
  transcript; `--grep X --from <id>` searches only that window.

```
clobber transcript <id> --grep 'clobber status'          # did it post status?
clobber transcript <id> --grep 'git checkout' --context 2 # find the call + nearby
clobber transcript <id> --grep 'env' --from 40 --detail low
```

## Investigation patterns

**"What did this worker do recently?"**
```
clobber transcript <id> --last 20
```

**"The user complained about something this worker said — what did it say?"**
```
clobber transcript <id> --last 50 --detail low
```
Strips out tool noise so you can read the conversation as the user would.

**"This tool call looks wrong — show me everything about it."**
```
clobber transcript <id> --entry 37 --detail full
```

**"What happened around the failure?"**
```
clobber transcript <id> --to 37 --limit 10
```

**"Pipe into another skill."**
```
clobber transcript <id> --last 100 --format json
```
JSON output is stable enough to feed into other tools you build.

## When to investigate

- A worker reported back something surprising — verify by reading its turns.
- The user is asking why a worker did X — find the actual cause, don't guess.
- You're considering writing a new skill — read past sessions where the missing
  skill would have helped, to ground the design in real behavior.

When **not** to investigate:

- The worker is mid-flight and you'd rather wait until it's idle. Check
  `clobber agents list` — only investigate idle sessions for stable reads, or
  accept that you're seeing a snapshot mid-turn.
