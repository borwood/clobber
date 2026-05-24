---
name: open-pr
description: Branch (worktree if the repo demands it), commit with conventional-commit messages, push, and open a PR with a structured body.
---

# open-pr

Land the change as a reviewable PR. The repo's `CLAUDE.md` is the source of
truth for branch naming, commit format, and PR body conventions; defer to it.

## Branch

**First check whether you're already in a worktree.** If the workspace spawned
you into one (`spawn_worktree` on), you start in a dedicated worktree on your
own branch — adding another would nest worktrees and fail. Detect it:

```sh
[ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ] \
  && echo "already in a worktree — skip worktree add"
```

If that prints (you're in a linked worktree), skip `git worktree add` entirely
and just commit on the current branch.

Otherwise, if the repo's `CLAUDE.md` mandates worktrees (clobber and several
adjacent repos do), use `git worktree add ../<slug> -b <branch> main` rather
than checking out in-place. The branch name follows whatever convention
`CLAUDE.md` sets — typically `<type>/<short-slug>`.

## Commits

- Conventional commits: `feat(scope): summary`, `fix(scope): summary`,
  `docs(scope): summary`, `refactor(scope): summary`, etc.
- One concept per commit. Don't bundle unrelated changes.
- Commit messages explain *why*, not what — the diff already shows what.
- **Never** skip hooks (`--no-verify`) or signing.

## PR body

Use `gh pr create --help` for the full flag set. The shape that works in this
ecosystem:

```
## Summary
<1–3 bullets on what changed and why>

## Test plan
- [x] new test added: <name>
- [x] full suite green
- [x] type-check clean

Closes #<issue-num>
```

Pass the body via a heredoc (`--body "$(cat <<'EOF' ... EOF)"`) so quoting and
backticks survive the shell.

## Done when

- Branch is pushed.
- PR is open and not in draft (unless the assignment said draft is fine).
- PR body has Summary, Test plan, and the right `Closes #N` link.

Mark the `open-pr` task as `completed` (via `TaskUpdate`) and the next phase
as `in_progress`. Then move to `watch-ci/`.
