---
name: watch-ci
description: Poll the PR's checks. On red, fetch the failing job's log, attempt a fix, push. On green, finish.
---

# watch-ci

The last phase. Sit on the PR until CI is green, fixing what you can.

## Watch

```
gh pr checks <pr-num> --watch
```

(Use `gh pr checks --help` for the full flag set. `--watch` polls until all
checks complete.)

## On red

1. **Identify the failing job.** `gh pr checks <num>` (no `--watch`) prints a
   summary; pick the one that says `fail`.
2. **Fetch its log.** `gh run view <run-id> --log-failed` shows just the
   failing step output.
3. **Read it before guessing.** Most CI failures are obvious from the log
   (missing dep, lint warning, flaky test). Don't push a speculative fix.
4. **Make the fix locally.** Re-run the failing test or check on your own
   machine first.
5. **Push as a new commit on the same branch.** Don't force-push unless the
   only change is a commit-message tweak — force-pushes invalidate review.

## When you're stuck

- If the failure isn't reproducible locally, the job is probably flaky.
  Re-run it once via `gh run rerun <run-id>` before adding fix attempts.
- If the failure is genuinely opaque after one careful read, post `clobber
  status blocked "<one line>"` and `clobber ask` for direction. Don't loop.

## Status

Post `clobber status working "phase: watch-ci — green"` when all checks pass.

## Done when

- All required checks are green.
- The PR is in a state a reviewer can merge without further work from you.

That's the end of the pipeline. Post one final `clobber status done "<one-
line outcome>"` summarizing what shipped and what (if anything) you'd flag
for the manager. Your session ends; the manager picks up from there.
