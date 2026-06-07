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

## Generated-docs gate (when applicable)

If the repo declares a `docs:gen` script in its root `package.json`, include
this as a local gate step before opening a PR:

```sh
# Regenerate from source
<runner> run docs:gen      # e.g. bun run docs:gen, npm run docs:gen

# Fail on any drift
git diff --exit-code
```

The gate is **conditional on the declared generator** — only run it if the
script exists. A workspace without a docs generator skips this step entirely.
A commit touching only the generated `docs/` tree should produce no new diff
(the generator is source-scoped, not docs-scoped).

## Done when

- The new test passes.
- The full suite passes.
- The type-checker is silent.
- No new lint warnings (run the repo's lint script if it has one).
- If `docs:gen` is declared: the gate is clean (no drift after regenerating).

Mark the `implement` task as `completed` (via `TaskUpdate`) and the next
phase as `in_progress`. Then move to `open-pr/`.
