---
name: failing-test
description: Write the test that demonstrates the bug or the missing feature. Run it. Confirm it fails for the expected reason.
---

# failing-test

Tests come **before** code. The repo's `CLAUDE.md` likely mandates this
explicitly; defer to it if it does.

## Steps

1. **Write the test.** Mirror the style of the nearest existing test file —
   same framework, same conventions, same assertion style. Don't introduce a
   new test layer.
2. **Run only the new test.** Don't run the whole suite yet. You want a fast
   feedback loop.
3. **Confirm it fails.** Read the failure message. The test should fail for
   the *expected* reason — the bug or the missing feature, not a typo or a
   stale import.

If it passes immediately, the test is wrong: it's not testing what you think
it is. Fix the test before moving on.

If it fails for the wrong reason (e.g. a setup error), fix the setup first —
a test that fails for the wrong reason gives no signal.

## Conventions

- **Integration over unit** unless `CLAUDE.md` says otherwise. Most clobber
  repos prefer full-flow tests over isolated function tests.
- **No mocks unless documented as the convention.** Hitting the real
  dependency is usually the right move.
- **Test timeouts are bugs.** If a test times out, find the underlying async
  issue. Don't bump the timeout.

## Done when

- The test exists in the right file with the right framework.
- It fails when run, for the expected reason.
- The failure message points at the gap your impl phase will close.

Mark the `failing-test` task as `completed` (via `TaskUpdate`) and the next
phase as `in_progress`. Then move to `implement/`.
