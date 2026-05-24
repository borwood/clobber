---
name: agent-triage
description: Review a finished worker session against ground truth — the role version it ran, its transcript, its claims — then merge, file, or log. The review-a-worker mirror of /assignment.
---

# agent-triage

`/agent-triage <session-id>` is your lever for turning *"a worker finished"*
into *"its work is merged, its real findings are filed, and nothing false
propagated."* It is the mirror of `/assignment`: that skill briefs a worker,
this one reviews one. Read it before triaging — the whole point is that a
worker's self-report is a **hypothesis**, not a fact, and this skill is the
discipline that verifies it before any claim becomes a ticket, a merge, or a
lesson.

The founding failure (2026-05-24): a worker reported "the contract says
`TodoWrite` but the harness exposes `Task*`." The manager filed a ticket
without checking, then "verified" it against the on-disk working tree — found
no `TodoWrite`, declared the worker wrong, and closed the ticket. Both moves
were wrong. The worker ran a **stale DB role version** that *did* say
`TodoWrite`; the working tree had already been fixed. The manager checked the
wrong layer of ground truth twice. Every step below exists to make that
impossible to repeat.

## The one rule above all others

**Ground truth for what a running agent did is the role version it ran (DB)
plus its transcript — NEVER the current working tree.** The working tree is
*current intent*. It drifts ahead of (and behind) what is actually loaded into
a live workspace — that gap is the whole "shipped ≠ running" problem. When you
want to know what a worker was told or did, you ask the bundle it ran and the
transcript of it running, not `git`.

## Steps you take

### 1. Pull the ground-truth triad — before reading the report's conclusions

For the session under triage, gather the three artifacts, in this order, and
read them before you form any opinion:

```bash
# (a) the role version it RAN — what it was actually told
python3 - <<'PY'
import sqlite3
db = sqlite3.connect("clobber.db")
sid = "<session-id>"
rv = db.execute("select role_version_id from sessions where id=?", (sid,)).fetchone()[0]
cols = [r[1] for r in db.execute("pragma table_info(role_versions)")]
row = db.execute("select * from role_versions where id=?", (rv,)).fetchone()
for c, v in zip(cols, row):
    print(f"=== {c} ===\n{v}\n")
PY

# (b) the transcript — what it actually DID
clobber transcript <session-id> --detail medium

# (c) its claims — the final report + status log
python3 - <<'PY'
import sqlite3
db = sqlite3.connect("clobber.db")
sid = "<session-id>"
for r in db.execute(
    "select kind,state,summary,details_json from agent_status_log "
    "where session_id=? order by created_at", (sid,)):
    print(r)
PY
```

The report's `well`/`badly`/`useful` fields are claims **about** the role
version and the transcript. Read those two first so you can judge the claims,
not absorb them.

### 2. Standing check — diff the role version against the on-disk bundle

Always, every triage. The worker ran the role version from the DB; `main` may
have moved. If the bundle it ran differs from the current on-disk role bundle,
**that divergence is itself a finding** — a stale live role version, and a
likely cause of whatever friction the worker reported.

```bash
# What does the role version's system_prompt say about the friction area?
# Compare to the on-disk source it was built from:
git -C <repo> show origin/main:packages/runtime/roles/<role>/system-prompt.md
```

If they diverge: the running workspace is loading a stale bundle. Surface it
(it belongs to the shipped-vs-running / role-version-reload family), and read
the worker's friction claims *against the version it ran*, not against `main`.
This one step would have caught the founding failure on the spot.

### 3. Verify success claims against the gating action

Before merging anything, re-run the gate yourself — don't trust the report's
"tests pass / typecheck clean / PR open." This is the half that was already
disciplined; keep it.

```bash
# in the worker's worktree, with CLOBBER_* unset (they leak into tests):
env -u CLOBBER_API_BASE -u CLOBBER_SESSION_TOKEN -u CLOBBER_SESSION_ID \
    -u CLOBBER_WORKSPACE_ID -u CLOBBER_AGENT_ID bun run type-check
env -u CLOBBER_API_BASE -u CLOBBER_SESSION_TOKEN -u CLOBBER_SESSION_ID \
    -u CLOBBER_WORKSPACE_ID -u CLOBBER_AGENT_ID bun test
```

There is no remote CI in this repo — the local suite + typecheck *is* the
gate. A claim that doesn't survive your own run is a red, not a merge.

### 4. Triage each friction note as a hypothesis, not a fact

For every `badly`/`useful` entry, locate the claimed cause in the **role
version + transcript** (step 1), never in the working tree. Then classify:

- **Real, and already fixed on disk** → it is a *propagation / stale-role-
  version* finding (the bundle the worker ran lags `main`), **not** a doc bug.
  Don't file a "fix the docs" ticket; the docs are fixed. Surface the
  staleness.
- **Real, and not yet fixed** → file or append — **after a duplicate search**
  (`gh issue list --state all --search "..."`). Cite the transcript line /
  role-version field as evidence in the issue body.
- **Worker error or confabulation** → the worker misread its own behavior or
  attributed a harness artifact to clobber. Don't file a code ticket;
  `wisdom-capture` the *behavior* if it's a recurring pattern worth teaching.
- **Stale brief on your side** → the friction traces to your `/assignment`
  brief, not the role or the repo. Fix the brief; that's the loop tightening.

**Causal attributions are the least reliable part of any report.** "The
contract says X" must be checked against the role version that *was* the
contract — not against what the contract says today.

### 5. Own the merge, then re-sync

If the success claims survived step 3 and the diff is clean, this skill owns
the merge — it is the end-to-end counterpart to `/assignment`:

```bash
gh pr merge <pr> --repo <owner>/<repo> --squash --delete-branch
git -C <repo> checkout main && git -C <repo> pull origin main   # pull latest main
```

Pre-merge, run the standard pre-PR checks (base is current `main`; no prior
merged PR from the same head; `MERGEABLE`/`CLEAN`).

### 6. Close the loop

- Remove the worker's worktree (`git worktree remove`), delete its branch
  (local + remote), `git worktree prune`.
- `clobber kill <session-id>`.
- Record outcomes traceable to evidence: the merge, any **verified** tickets
  (with citations), any wisdom entries. Update your project's roadmap/PM
  record if the triage changed plans.
- Anything not grounded in the triad → leave in a *needs-grounding* state;
  do **not** file it. A parked lead is recoverable; a false ticket propagates.

## When to refuse to act on a claim

Don't file, merge, or log on a claim you could not ground in the triad:

- The friction names a file/tool/contract you did not confirm in the role
  version or transcript.
- The success claim didn't survive your own gate run.
- A would-be ticket has no transcript/role-version citation to put in its body.

A parked, ungrounded lead is cheaper than a wrong ticket — the ticket outlives
the session that could have corrected it, and feeds the next worker's brief.

## Composes with

- **#196 reports queue** — the inbox this skill drains (final reports land in
  the DB; this is the read-and-act side).
- **`clobber transcript`** (and `--grep`, #195) — step 1(b) and the future
  search over transcripts.
- **`/assignment`** — the mirror. A friction note that traces to a thin brief
  is fixed there.
- **`wisdom-capture`** — step 4's behavioral path, for findings worth teaching
  future briefs.
