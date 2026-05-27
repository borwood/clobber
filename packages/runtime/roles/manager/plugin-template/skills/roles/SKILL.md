---
name: roles
description: Inspect, fork, and edit the roles available in this workspace. Roles are how you encode "what a worker is" — system prompt, skills, tool allowlist, triggers, seeds, and wake-programs.
---

# roles

You are a role engineer, not just an orchestrator. The `roles` command is how
you read and reshape the role library: what kinds of workers exist, what they
know how to do, and how they should behave. Use it to audit a role before
spawning, to evolve a role you've seen come up short, or to fork a new variant
for a workflow that doesn't fit any existing role.

```
clobber roles <list|show|fork|edit|ceiling|seeds|wake-programs> [args...] [--json]
```

The composed system prompt a worker receives at spawn has three layers
(epic #209): **A** role framing, **B** seeds, **C** the wake-program addon.
`edit` shapes A (the system prompt) and the skill/tool surface; `seeds` shapes
B; `wake-programs` shapes C and the opening kick. Reach for the seed/wake verbs
at *authoring time* — when you're deciding what a role knows on every spawn and
how it opens its session — not at boot.

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

### `roles seeds <name|id> [add|enable|disable <seed> [--disabled]]`

Seeds are layer-B compositional units of the system prompt — shareable,
per-role-toggleable. With no action, lists the role's seed refs and whether
each is enabled. `add` appends a ref (enabled unless `--disabled`); `enable` /
`disable` flip an existing ref. Every change routes through the same versioned
edit path as `edit`, so it bumps the role version.

```
clobber roles seeds my-worker                       # list refs + enabled state
clobber roles seeds my-worker add repo-sdlc         # ref an existing catalog seed
clobber roles seeds my-worker add house-rules --disabled
clobber roles seeds my-worker disable wisdom-pointer
```

A ref points at a **catalog seed by name**. The catalog is the shipped defaults
(`office-manifest`, `repo-sdlc`, `wisdom-pointer`) overlaid by the workspace's
filesystem catalog at `<repo>/.clobber/seeds/<name>/seed.json`. A shipped
default carries no privilege over one you author — both resolve through the same
path at spawn.

**Authoring a new seed definition** (static text or a dynamic script) means
writing that catalog file, then ref'ing it with `roles seeds … add <name>`:

```jsonc
// <repo>/.clobber/seeds/house-rules/seed.json — a static seed
{ "kind": "static", "text": "House rule: never force-push shared branches." }
```
```jsonc
// <repo>/.clobber/seeds/branch-status/seed.json — a dynamic seed.
// The {exec|http|noop} provider's command/args ARE the script; its stdout is
// composed into the prompt at spawn. A filesystem entry shadows a default of
// the same name.
{ "kind": "dynamic",
  "provider": { "kind": "exec", "command": "git", "args": ["status", "--short"] } }
```

There is no separate script file to register — the provider spec is the script,
and `<repo>/.clobber/seeds/` is the one place it lives. The seed must exist in
the catalog before you `add` a ref to it.

### `roles wake-programs <name|id> [show|add|edit|remove <name> ...]`

A wake-program is a role's **opening move**: layer-C system addon (`--system`,
"regardless of the first message, do X first") plus the opening user-message
kick (`--user`, or `--no-user` for none). `idle` is the universal built-in —
no addon, no kick — shown in the list but not authored (it's reserved). All
changes route through the versioned edit path.

```
clobber roles wake-programs my-worker                         # list (idle + role programs)
clobber roles wake-programs my-worker show triage             # see one program's channels
clobber roles wake-programs my-worker add triage \
    --system-file ./triage-c.md --user "Triage the inbound queue now."
clobber roles wake-programs my-worker add watch \
    --system "Watch CI and report." --no-user
clobber roles wake-programs my-worker edit triage --user "Triage and escalate."
clobber roles wake-programs my-worker remove watch
```

`add` requires both a `--system`/`--system-file` source and a kick decision
(`--user` or `--no-user`). `edit` changes only the channels you pass, leaving
the rest intact.

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
