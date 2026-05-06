---
name: roles
description: Inspect, fork, and edit the roles available in this workspace. Roles are how you encode "what a worker is" — system prompt, skills, tool allowlist, triggers.
---

# roles

You are a role engineer, not just an orchestrator. The `roles` command is how
you read and reshape the role library: what kinds of workers exist, what they
know how to do, and how they should behave. Use it to audit a role before
spawning, to evolve a role you've seen come up short, or to fork a new variant
for a workflow that doesn't fit any existing role.

```
clobber roles <list|show|fork|edit|ceiling> [args...] [--json]
```

## Subcommands

### `roles list`

Overview of roles registered in this workspace, with current version and
ceiling. Start here when you don't know what's available.

```
clobber roles list
```

### `roles show <name|id>`

Full role: description, system prompt, skill files, allowed tools, triggers,
and version history. This is the truth about what a worker of this role
actually receives at spawn time.

```
clobber roles show worker
```

Use it before spawning into an unfamiliar role, or as the first step before
forking.

### `roles fork <source> <new-name>`

Branch an existing role into a new editable workspace role. The new role
starts as a copy — same system prompt, same skills, same tool allowlist —
and is yours to evolve.

```
clobber roles fork worker repro-worker
```

Forking is cheap and reversible. Reach for it whenever you want to try a
variant without touching the parent.

### `roles edit <name|id> [flags]`

Patch a role. The flags below replace fields wholesale (no merging):

| Flag | Effect |
|---|---|
| `--system-prompt-file FILE` | Replace system prompt from a file. |
| `--system-prompt -` | Replace system prompt from stdin. |
| `--allowed-tools t1,t2` | Replace the allowed-tool list. |
| `--add-skill name=FILE` | Add (or replace) a skill. Repeatable. |
| `--remove-skill name` | Remove a skill by name. Repeatable. |
| `--triggers JSON` / `--triggers-file FILE` | Replace triggers. Persistent roles only. |
| `--description TEXT` / `--description-file FILE` | Update the human-readable description. |

**Versioning rule:** changes to `system_prompt`, `skills`, `allowed_tools`, or
`triggers` bump the role to a new version. Description-only edits do not.
Workers spawned from the role pin to the version that was current at spawn
time, so an in-flight session keeps the prompt it started with — your edits
take effect on the next spawn.

```
clobber roles edit repro-worker --add-skill bisect=./bisect.md
clobber roles edit repro-worker --allowed-tools Bash,Read,Edit,Grep
```

### `roles ceiling <name|id> <max>`

Cap how many concurrent active sessions of this role can run in this
workspace. Hit ceiling and `clobber spawn` will refuse with `role at capacity`.

```
clobber roles ceiling repro-worker 2
```

Default is 0 for new workspace-roles after fork — set a ceiling before you
expect to spawn.

## The role-engineering loop

Fork → edit → test → iterate.

1. `roles show worker` — read the current state.
2. `roles fork worker my-variant` — branch.
3. `roles edit my-variant --add-skill ...` — make a focused change.
4. `roles ceiling my-variant 1` — allow one concurrent session.
5. `spawn my-variant --prompt "..."` — try it.
6. `transcript <session-id>` — read what happened.
7. Loop: another `roles edit` based on what you saw, then spawn again.

The loop is the point. You can't design a good role from first principles —
you design by watching real sessions and patching the gaps you see.

## When to fork vs edit in place

- **Edit in place** when the change is unambiguously an improvement (typo in
  a skill, a clearly-missing tool, a description fix). Other workers of this
  role will see the new version on their next spawn.
- **Fork** when you're experimenting, when the change suits one workflow but
  not the general role, or when you'd want to A/B two variants. The parent
  stays clean.

## When not to use this skill

- The user is asking you to *do* something with a worker, not to design a new
  worker. Spawn first; only reach for `roles` if no existing role fits.
- A role is misbehaving and you don't yet know why. Read transcripts first
  (`transcript <session-id>`) — edits without grounding produce noise.
- The bug is in the worker's actual code, not its role definition. Don't
  paper over a code bug with a prompt patch.
