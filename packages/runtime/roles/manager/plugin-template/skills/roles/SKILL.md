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
clobber roles <list|show|checkout|diff|commit|discard|fork|edit|ceiling|seeds|wake-programs> [args...] [--json]
```

A role **is a git branch**. You edit one the way you edit code: `checkout` its
branch into a working copy on your desk, edit the files with normal tools,
`diff` to review, `commit` to serialize the edits back onto the branch and
advance its pin. `checkout -b` forks a new role as a fresh branch. A `commit`
advances the branch pin; an in-flight session keeps the exact commit it booted
from, so your edits land on the *next* spawn — never mid-session.

The composed system prompt a worker receives at spawn has three layers
(epic #209): **A** role framing, **B** seeds, **C** the wake-program addon.
`edit` shapes A (the system prompt) and the skill/tool surface; `seeds` shapes
B; `wake-programs` shapes C and the opening kick. Reach for the seed/wake verbs
at *authoring time* — when you're deciding what a role knows on every spawn and
how it opens its session — not at boot.

## Subcommands

### `roles list`

Overview of roles registered in this workspace, with each role's commit pin and
ceiling. Start here when you don't know what's available.

```
clobber roles list
```

### `roles show <name|id>`

Full role: description, system prompt, skill files, allowed tools, triggers,
and its branch/commit lineage. This is the truth about what a worker of this
role actually receives at spawn time.

```
clobber roles show worker
```

Use it before spawning into an unfamiliar role, or as the first step before
forking.

### `roles checkout <name|id>` → edit → `diff` → `commit`

The working copy: edit a role like code. `checkout` materializes the role's
branch into `role-checkout/` on your desk and writes a `ROLE.md` at its root
(YAML frontmatter — name / description / persistent / effort — plus an
edit-spec body that names every file). Edit the files with normal Read/Edit/
Write, `diff` to see what changed, then `commit` to serialize the tree back
onto the branch and advance the pin.

```
clobber roles checkout repro-worker     # materialize the branch into the desk
# …edit system-prompt.md, skills/<name>/SKILL.md, ROLE.md frontmatter, …
clobber roles diff                       # review the working copy vs the branch tip
clobber roles commit -m "add bisect skill"
clobber roles discard                    # throw the working copy away (branch untouched)
```

`commit` advances the branch and re-pins the role to the new tip — **no new
version row, no demotion**. An in-flight session keeps the exact commit it
booted from; your edit takes effect on the next spawn. `discard` resets the
working copy without touching the branch. One checkout is open per desk at a
time; `status` (below) tells you what's open.

### `roles checkout -b <new-name> --from <source>` (alias: `roles fork`)

Fork a role as a fresh git branch off the source tip. The new workspace role
is commit-pinned to its own `<new-name>` branch — a copy of the source's
content (same prompt, skills, tools), commit-backed like every other role, with
the source's ceiling inherited. `roles fork <source> <new-name>` is a thin
alias for the same operation.

```
clobber roles checkout -b repro-worker --from worker
clobber roles fork worker repro-worker          # identical result
```

Forking is cheap and reversible: it branches the source, never touches it.
Reach for it whenever you want to try a variant without disturbing the parent.

### `roles status`

Is a checkout open? For which role and branch? Which files changed, and has the
branch tip advanced past your checkout (stale)? A pure read of the desk working
copy against the branch tip.

```
clobber roles status
```

### `roles edit <name|id> [flags]`

A targeted alternative to the working copy: patch one or more fields in a single
command, no checkout required. The flags below replace fields wholesale (no
merging):

| Flag | Effect |
|---|---|
| `--system-prompt-file FILE` | Replace system prompt from a file. |
| `--system-prompt -` | Replace system prompt from stdin. |
| `--allowed-tools t1,t2` | Replace the allowed-tool list. |
| `--add-skill name=FILE` | Add (or replace) a skill. Repeatable. |
| `--remove-skill name` | Remove a skill by name. Repeatable. |
| `--triggers JSON` / `--triggers-file FILE` | Replace triggers. Persistent roles only. |
| `--description TEXT` / `--description-file FILE` | Update the human-readable description. |

Like `commit`, an `edit` advances the role and takes effect on the next spawn;
an in-flight session keeps the prompt it booted with. Reach for the working copy
(`checkout` → edit → `commit`) when you want to stage several file edits and
review the composed whole before publishing; reach for `edit` for a single
focused field change.

```
clobber roles edit repro-worker --add-skill bisect=./bisect.md
clobber roles edit repro-worker --allowed-tools Bash,Read,Edit,Grep
```

### `roles seeds <name|id> [add|enable|disable <seed> [--disabled]]`

Seeds are layer-B compositional units of the system prompt — shareable,
per-role-toggleable. With no action, lists the role's seed refs and whether
each is enabled. `add` appends a ref (enabled unless `--disabled`); `enable` /
`disable` flip an existing ref. Every change advances the role like `edit` does
— it takes effect on the next spawn, never mid-session.

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
changes advance the role and take effect on the next spawn.

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

A `checkout -b` / `fork` inherits the source's ceiling, so a fork is spawnable
immediately — adjust it here when the variant needs a different cap.

## The role-engineering loop

Branch → checkout → edit → diff → commit → test → iterate.

1. `roles show worker` — read the current state.
2. `roles checkout -b my-variant --from worker` — branch a fresh role.
3. `roles checkout my-variant` — materialize its working copy on your desk.
4. Edit the files (`system-prompt.md`, `skills/<name>/SKILL.md`, `ROLE.md`, …).
5. `roles diff` → `roles commit -m "…"` — review, then publish onto the branch.
6. `spawn my-variant --prompt "..."` — try it (the fork inherits a ceiling).
7. `transcript <session-id>` — read what happened.
8. Loop: re-`checkout`, edit, `commit` based on what you saw, then spawn again.

The loop is the point. You can't design a good role from first principles —
you design by watching real sessions and patching the gaps you see. The branch
is the version history; the working copy is the draft; `commit` is publish.

## When to branch vs edit in place

- **Edit in place** (`checkout` the existing role → `commit`, or a targeted
  `edit`) when the change is unambiguously an improvement (typo in a skill, a
  clearly-missing tool, a description fix). Other workers of this role pick up
  the new commit on their next spawn.
- **Branch** (`checkout -b` / `fork`) when you're experimenting, when the change
  suits one workflow but not the general role, or when you'd want to A/B two
  variants. The parent branch stays untouched.

## When not to use this skill

- The user is asking you to *do* something with a worker, not to design a new
  worker. Spawn first; only reach for `roles` if no existing role fits.
- A role is misbehaving and you don't yet know why. Read transcripts first
  (`transcript <session-id>`) — edits without grounding produce noise.
- The bug is in the worker's actual code, not its role definition. Don't
  paper over a code bug with a prompt patch.
