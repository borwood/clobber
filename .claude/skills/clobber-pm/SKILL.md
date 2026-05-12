---
name: clobber-pm
description: Project manager for clobber. Reads, briefs, and updates the pinned [ROADMAP] (#70) and [VISION] (#95) issues. Subcommands — `orient` (default), `next`, `note`, `milestone`, `narrative`, `narrative write`. Use whenever the user asks "where are we", "what's next", "log a decision", "close this milestone", or wants to start/end a session with a vision narrative.
---

# /clobber-pm — clobber project manager

> Two pinned issues anchor this skill:
> - **brennan-volter/clobber#70** (label `pm:roadmap`) — load-bearing project state: milestone, work-items, decisions log.
> - **brennan-volter/clobber#95** (label `pm:vision-log`) — softer companion: dated session-narratives that articulate the north star *right now*. Comparing successive entries shows how the framing evolves.
>
> Never edit either issue's body by hand outside the `milestone` subcommand — comments are the audit trail.

## Subcommand dispatch

| Args pattern | Branch |
|---|---|
| no args, or `orient` | **A: Orient** |
| `next` | **B: Next** |
| `note <text>` | **C: Note** |
| `milestone <new title>` | **D: Roll milestone** |
| `narrative` | **E: Read latest narrative** |
| `narrative write` | **F: Write new narrative** |

If args don't match, output the six signatures and stop.

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

**Step 3 — Surface the latest vision-narrative pointer.** One additional `gh` call:

```bash
gh issue view 95 --repo brennan-volter/clobber --json comments --jq '.comments[-1] | "\(.createdAt[:10]): \(.body | split("\n")[0])"'
```

Pick the most recent comment's date + first line (often the dated header with optional theme).

**Step 4 — Output to user (5–8 lines for the brief, plus one line for the narrative pointer):**

1. Current milestone name + acceptance bar (one line)
2. Work-items status: ✅ shipped / 🟡 in-flight (open PR or worktree) / ⏳ next-up / 🔴 blocked
3. Most recent decision from the comments log (1 line, with date)
4. Open PRs touching the current milestone (numbers + draft/ready)
5. Anything that just unblocked (upstream merged → downstream now actionable)
6. Recommended next move
7. **Vision narrative**: one-line pointer to the most recent #95 entry (date + theme). Suggest `/clobber-pm narrative` if today's work touches vision-shaped territory.

End with: *"Want me to `/clobber-pm next` and pick the next sub-issue? When you wrap, run `/clobber-pm narrative write` to log a fresh narrative."*

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

## Branch E: Read latest narrative

Goal: surface the most recent vision-narrative entry from #95 in full, so the user can re-orient on the current framing before deciding direction.

```bash
gh issue view 95 --repo brennan-volter/clobber --json comments --jq '.comments[-1].body'
```

Print the body verbatim. No commentary, no synthesis — let the prose speak. End with a single-line offer: *"When this session wraps, `/clobber-pm narrative write` will log a fresh entry."*

Use this when:
- The user explicitly invokes `/clobber-pm narrative`.
- The user is starting a session whose work touches architecture, primitives, or principles.
- You're about to make a non-trivial design call and want vision context before recommending.

---

## Branch F: Write new narrative

Goal: compose one fresh dated session-narrative and append it as a comment to #95. This is a **synthesis** task, not a status report — what the prose captures is *the framing*, not *the work*.

**Step 1 — Read the inputs that should inform the narrative:**

```bash
gh issue view 95 --repo brennan-volter/clobber --json comments --jq '.comments[-1].body'   # most recent narrative — the baseline you're iterating from
gh issue view 70 --repo brennan-volter/clobber --json body                                  # current vision pillars + milestone shape
gh issue view 70 --repo brennan-volter/clobber --json comments --jq '.comments[-5:]'        # last 5 decisions (what crystallized this stretch)
```

Then scan the conversation context for what shifted in *this* session — new design calls, primitives that came into sharper relief, metaphors that stopped being decoration and started being load-bearing.

**Step 2 — Run the blue-sky reframe privately, before drafting.** Ask: *what could clobber be if it were absolutely insanely useful, novel, enjoyable, dependable?* Don't dump every option in the narrative. The reframe is a *discipline* — it loosens the framing so the prose can land somewhere the previous narrative couldn't have. If one of the reframes is genuinely interesting (re-shapes a primitive, opens up a new pillar, eliminates a category of future work), surface it to the human for a quick sanity-check before logging — *"I was about to log X, but the reframe suggested Y; want me to take that direction instead?"* Otherwise stay quiet and let the prose absorb the better framing.

**Step 3 — Compose the narrative.** Target 500–900 words of prose. The discipline:

- **Principles, not progress.** Don't list what shipped — that lives in #70's decisions log. Articulate *what clobber is* right now.
- **Show the delta.** If the framing has shifted from the previous narrative, name the shift explicitly. *"Last week the office metaphor was decoration; today it's the security boundary."*
- **Cite features as evidence, not topics.** A primitive is mentioned because it makes a load-bearing claim true (`#94` is cited because *the workspace tends to its agents*; not because *we shipped #94*).
- **Prose, not bullets.** Sub-headers are fine. Bulleted lists almost always mean you're hiding from synthesis.
- **One closing sentence** that compresses the whole thing — the line that should survive every refactor.

**Step 4 — Append as a dated comment:**

```bash
gh issue comment 95 --repo brennan-volter/clobber --body "$(cat <<EOF
**$(date -u +%Y-%m-%d)** — <one-line theme>

<narrative body, prose>
EOF
)"
```

**Step 5 — Show the user the entry URL** (returned by `gh issue comment`) so they can read it back.

If the narrative would be substantially the same as the previous entry — no shifts, no new framings — say so and **skip writing**. The log is for genuine evolution; identical entries are noise.

---

## Conventions

- **One pinned roadmap issue:** brennan-volter/clobber#70 (label `pm:roadmap`). Don't file a second one.
- **One pinned vision-log issue:** brennan-volter/clobber#95 (label `pm:vision-log`). Don't file a second one.
- **Append-only comments on both:** never delete or edit a decision or narrative comment. If a decision is reversed, write a new comment that says *"reversing 2026-05-06 decision on X because Y"*. If a framing has changed, write a new narrative that reframes — let readers see the evolution.
- **Stable section headers in #70's body:** `## Vision pillars`, `## Recently shipped (foundation)`, `## Current focus: <name>`, `## Next likely milestone (sketch …)`, `## Decisions log (last 10)`, `## Deferred — and why`. Don't rename them.
- **Labels:** `pm:roadmap` (the one roadmap issue), `pm:vision-log` (the one vision-log issue), `pm:milestone-active` (the active milestone-defining issue if any), `pm:milestone-done` (archived milestones).
- **Don't pollute #70's comments with chitchat.** Comments are decisions, milestone rolls, and roadmap-shape changes — nothing else. Status updates that aren't decisions go in the relevant feature issue.
- **Don't pollute #95's comments with status reports.** The vision log is for principles and framing, not progress. Anything that lists what shipped goes in #70.

## Quick references

| Resource | Location |
|---|---|
| Roadmap issue | https://github.com/brennan-volter/clobber/issues/70 |
| Vision-log issue | https://github.com/brennan-volter/clobber/issues/95 |
| Repo CLAUDE.md | `<clobber-root>/CLAUDE.md` |
| README (vision) | `<clobber-root>/README.md` |
| Architecture north-star | `<clobber-root>/docs/architecture/agent-model.md` |
| Issue conventions (clobber-style) | `## Why`, `## Proposal`, `## Open questions`, `## Out of scope`, `## Severity / priority`, `## Related` (see #61–#69 for examples) |

## Sunset

This skill becomes redundant when clobber dogfoods its own role-engineering — at that point the manager agent will maintain its own roadmap notes via office files, and `/clobber-pm` becomes a thin shell over the manager's tools or disappears entirely. Don't sunset until that pivot is real and tested.
