---
name: clobber-pm
description: Project manager for clobber. Reads, briefs, and updates the pinned [ROADMAP] issue (brennan-volter/clobber#70) and orchestrates milestone-defining issues. Subcommands — `orient` (default), `next`, `note`, `milestone`. Use whenever the user asks "where are we", "what's next", "log a decision", or "close this milestone."
---

# /clobber-pm — clobber project manager

> Living roadmap lives at **brennan-volter/clobber#70** (label `pm:roadmap`, pinned). This skill reads it, briefs the session, recommends next work, and appends decisions. Never edit #70's body by hand outside the `milestone` subcommand — comments are the audit trail.

## Subcommand dispatch

| Args pattern | Branch |
|---|---|
| no args, or `orient` | **A: Orient** |
| `next` | **B: Next** |
| `note <text>` | **C: Note** |
| `milestone <new title>` | **D: Roll milestone** |

If args don't match, output the four signatures and stop.

---

## Branch A: Orient (default)

Goal: brief the session on where clobber is in 5–8 lines so the user can decide what to do next.

**Step 1 — Read state, in this order:**

```bash
gh issue view 70 --repo brennan-volter/clobber                                    # roadmap body
gh issue view 70 --repo brennan-volter/clobber --comments                         # decisions log
gh issue list  --repo brennan-volter/clobber --state open --limit 50 --json number,title,labels,createdAt
gh pr list     --repo brennan-volter/clobber --state open --json number,title,headRefName,isDraft
git -C /home/bjnwo/claude-workspace/brennan_volter.ai/brennan-volter/clobber log --oneline -10 main
```

**Step 2 — Parse the roadmap body's load-bearing sections:**

- `## Current focus: <name>` — current milestone title + work items + dep order
- `## Decisions log (last 10)` — most recent ~5 entries
- `## Deferred — and why` — what we've consciously parked

**Step 3 — Output to user (5–8 lines max):**

1. Current milestone name + acceptance bar (one line)
2. Work-items status: ✅ shipped / 🟡 in-flight (open PR or worktree) / ⏳ next-up / 🔴 blocked
3. Most recent decision from the comments log (1 line, with date)
4. Open PRs touching the current milestone (numbers + draft/ready)
5. Anything that just unblocked (upstream merged → downstream now actionable)
6. Recommended next move

End with: *"Want me to `/clobber-pm next` and pick the next sub-issue?"*

---

## Branch B: Next — pick the next unblocked sub-issue

**Step 1 — Re-read the roadmap's `## Current focus` section.** Don't trust the previous orient — milestones change.

**Step 2 — Build the candidate set:** sub-issues listed in `Current focus` whose status isn't ✅. For each candidate:

```bash
gh issue view <num> --repo brennan-volter/clobber --json state,assignees,body,title
```

Skip if: closed; assigned to anyone; in `Deferred` section; has an open PR closing it.

**Step 3 — Evaluate dep gates from the dependency block in the roadmap body.** A candidate is **clear** iff every upstream issue is closed (and the closing PR is merged on `main`):

```bash
# For each upstream <up>:
gh pr list --repo brennan-volter/clobber --state merged --search "closes:#<up>" --json number,mergedAt
```

**Step 4 — Rank clear candidates** by: (a) how many downstream items they unblock, then (b) lowest design-question count in the issue body. (Issue bodies in clobber follow the `## Open questions` convention — count them.)

**Step 5 — Output:**

- Issue # and title
- Why now: which gates just cleared, what it unblocks downstream
- Open questions count + the top 1–2 questions to resolve before coding
- Suggested branch name following clobber's convention (per `CLAUDE.md` worktree rule, when enforced — until then, trunk-based on `main`)
- One-line note on whether this is bundled with another issue (read the milestone work-items block for bundle hints)

If no candidate is clear, list the blocking upstreams and ask whether to push on the gate or pivot to a deferred item.

---

## Branch C: Note — append a decision to the roadmap

Goal: timestamp a decision into #70's comments. Comments are append-only and chronological — they're the project's audit trail.

**Format (always lead with bold ISO date):**

```
**YYYY-MM-DD** — <short subject>

<content as bullets or prose>

Related: #<n>, #<n>
```

**Step 1 — Decide whether the body's `## Decisions log (last 10)` should also be updated.** Only update the body when the decision *materially changes plans* (e.g., a milestone work-item gets added, a deferred issue moves to act-on, a vision pillar gets reframed). Routine status updates stay in comments only.

**Step 2 — Write the comment:**

```bash
gh issue comment 70 --repo brennan-volter/clobber --body "$(cat <<EOF
**$(date -u +%Y-%m-%d)** — <subject>

<body>

Related: #<n>
EOF
)"
```

**Step 3 — If body update is warranted:** edit #70's body to prepend a one-line entry to `## Decisions log (last 10)` and trim the oldest entry if there are more than 10. Keep the section header verbatim — the parser depends on it.

```bash
gh issue edit 70 --repo brennan-volter/clobber --body-file /tmp/clobber-roadmap-new.md
```

Always link the relevant feature issue numbers in the `Related:` line. Future-you scrolls comments looking for *"what was the call on #65 again?"* — the link makes that fast.

---

## Branch D: Roll milestone — close current, declare next

Use when the current milestone's acceptance bar is met and we're ready to declare what's next.

**Step 1 — Verify acceptance.** Read `## Current focus`'s acceptance bar. Confirm with the user that every line of it is met. Don't roll on enthusiasm.

**Step 2 — Comment a recap:**

```
**YYYY-MM-DD** — Milestone shipped: <title>

Closed: <list of issues that landed under this milestone>
What we learned: <2–4 bullets>
What we deferred from this milestone (re-evaluate next time): <if any>
```

**Step 3 — Edit #70's body:**

- Move the entire `## Current focus: <old>` section into `## Recently shipped (foundation)` as a new row (status ✅, link the milestone issue if one was filed, list closed issues).
- Replace `## Current focus: <old>` with `## Current focus: <new title>` populated from the `## Next likely milestone (sketch)` section (or from the user's input if they redirect).
- Replace `## Next likely milestone (sketch)` with a fresh sketch — ask the user what comes after `<new title>` if they haven't said.

**Step 4 — Append the milestone roll to `## Decisions log (last 10)`.**

If the new milestone has formal sub-issues with GitHub native sub-issue relationships, file a `[MILESTONE] <new title>` issue with `pm:milestone-active` label and link it from `## Current focus`. Move the previous milestone-active issue (if any) to `pm:milestone-done`. For lightweight milestones, the body section is enough — don't file ceremony.

---

## Conventions

- **One pinned roadmap issue:** brennan-volter/clobber#70 (label `pm:roadmap`). Don't file a second one.
- **Append-only comments:** never delete or edit a decision comment. If a decision is reversed, write a new comment that says *"reversing 2026-05-06 decision on X because Y"* — the audit trail is the point.
- **Stable section headers in #70's body:** `## Vision pillars`, `## Recently shipped (foundation)`, `## Current focus: <name>`, `## Next likely milestone (sketch …)`, `## Decisions log (last 10)`, `## Deferred — and why`. Don't rename them.
- **Labels:** `pm:roadmap` (the one roadmap issue), `pm:milestone-active` (the active milestone-defining issue if any), `pm:milestone-done` (archived milestones).
- **Don't pollute #70's comments with chitchat.** Comments are decisions, milestone rolls, and roadmap-shape changes — nothing else. Status updates that aren't decisions go in the relevant feature issue, not here.

## Quick references

| Resource | Location |
|---|---|
| Roadmap issue | https://github.com/brennan-volter/clobber/issues/70 |
| Repo CLAUDE.md | `<clobber-root>/CLAUDE.md` |
| README (vision) | `<clobber-root>/README.md` |
| Architecture north-star | `<clobber-root>/docs/architecture/agent-model.md` |
| Issue conventions (clobber-style) | `## Why`, `## Proposal`, `## Open questions`, `## Out of scope`, `## Severity / priority`, `## Related` (see #61–#69 for examples) |

## Sunset

This skill becomes redundant when clobber dogfoods its own role-engineering — at that point the manager agent will maintain its own roadmap notes via office files, and `/clobber-pm` becomes a thin shell over the manager's tools or disappears entirely. Don't sunset until that pivot is real and tested.
