---
name: self-skills
description: Grant or release skills on your own role from the workspace's skill catalog, within workspace-defined policy. This is how a manager adapts its own capabilities without forking.
---

# self-skills

You are a role engineer for *yourself*. While `roles` lets you reshape
the role library for other workers, `self-skills` lets you mutate your
*own* skill list — pulling in workspace-shipped skills the workspace's
policy has cleared you to grant.

```
clobber self-skills <list|grant|release> [<name>] [--json]
```

Each grant/release writes a `kind=skill-self-grant` audit row and bumps
your role's version (forks/spawns of your role pick up the change on
their next start; your current session continues with the version it
booted with).

## Subcommands

### `self-skills list`

What's currently granted, what the workspace catalog ships, and the
policy that gates grants.

```
clobber self-skills list
```

The output has three signals per skill:

- **NAME** — the skill name.
- **STATUS** — `granted` (in your skill list now) or `available` (in the
  workspace catalog but not yet granted).
- **POLICY** — `yes` (in `manager_skill_policy.allowed_skills`, so a
  grant call would succeed if the skill is in the catalog) or `no`.

Start here when you don't know what the workspace has shipped, or when
you're trying to figure out *why* a grant call is being refused.

### `self-skills grant <name>`

Add a catalog skill to your skill list.

```
clobber self-skills grant workspace-pm
```

Refusals (and why):

- `403 self-grant disabled by workspace policy` — the workspace has
  `manager_skill_policy.allow_self_grant = false`. You cannot self-edit
  until a human raises the policy.
- `403 skill 'X' not in workspace allowed_skills` — the workspace
  allow-listed *some* skills but not this one.
- `404 skill 'X' not in workspace catalog` — the name is allow-listed
  but no `<repo>/.clobber/skills/X/SKILL.md` file exists. Either the
  workspace forgot to ship the file or you spelled the name wrong.
- `409 skill 'X' already granted` — idempotent: you already have it.

When refused, **don't retry blindly**. The refusal is the workspace
saying *not now* — note it (`clobber note`) and move on.

### `self-skills release <name>`

Remove a previously-granted skill.

```
clobber self-skills release workspace-pm
```

Use this when:
- A grant turned out to be the wrong shape for the workflow.
- A workspace's catalog version of the skill has been superseded.
- You want to test how the workspace behaves without a skill you
  previously needed.

Release is also policy-gated: if the workspace has since set
`allow_self_grant: false`, release is blocked (a human un-grants by
PATCH-ing the role directly).

## When to use this skill

- You're picking up a workspace for the first time and need to learn
  what skills exist before you can think about which ones to grant
  yourself.
- You're hitting a gap mid-task (e.g. there's a workspace-specific PM
  skill you keep wishing you had) — `list`, then `grant` if the policy
  allows.
- A skill is fighting you (its instructions don't match the workflow
  you're walking) — `release` it, do the work raw, and `clobber note`
  the gap so the human can decide whether to evolve the skill.

## When not to use this skill

- The capability you need is not in the workspace catalog at all.
  Self-grant cannot synthesize skills — it can only pull from what the
  workspace has shipped under `<repo>/.clobber/skills/`. If the skill
  doesn't exist, `clobber note` the gap so a human can ship one (or
  fork a worker role with the skill via `roles fork` + `roles edit
  --add-skill`).
- The skill you want to mutate belongs to another role (worker, etc.).
  This skill operates on *your* role only — use `roles edit` for
  other roles.
- The change is permanent infrastructure (a skill every future manager
  should ship with). That belongs in the engine's manager bundle, not
  in a self-grant — surface it to the human.
