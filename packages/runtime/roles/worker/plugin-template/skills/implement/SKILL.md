---
name: implement
description: Make the failing test pass. Run the full suite + type-check before declaring done.
---

# implement

Make the test you just wrote go green, and don't break anything else.

## Steps

1. **Smallest viable change.** Don't refactor surrounding code "while you're
   here." A bug fix doesn't need cleanup; a one-shot doesn't need a helper.
   The repo's `CLAUDE.md` probably says this explicitly.
2. **Run the failing test repeatedly** while iterating.
3. **When green, run the full suite.** Don't skip this — your change might
   have broken a sibling test you didn't read.
4. **Run the type-check.** (`bun run typecheck`, `tsc --noEmit`, whatever
   the repo uses — check `package.json` scripts.)

## Anti-patterns to avoid

- **Defensive null/error handling for cases that can't happen.** Trust
  internal code and framework guarantees; only validate at system boundaries.
- **Backwards-compat shims** for code paths you can just change.
- **Comments that explain *what* the code does.** Good names beat comments.
  Comments are for *why* a non-obvious choice was made.

## Done when

- The new test passes.
- The full suite passes.
- The type-checker is silent.
- No new lint warnings (run the repo's lint script if it has one).

Mark the `implement` item in your `TodoWrite` list as `completed` and the
next phase's item as `in_progress`. Then move to `open-pr/`.
