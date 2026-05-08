---
name: research
description: Orient yourself before coding. Read the issue, related issues, prior PRs, and the surrounding code. Output a short orientation note.
---

# research

The first phase. You haven't earned the right to write any code yet — you've
earned the right to understand.

## What to read

1. **The issue itself.** Body, every comment, every linked / cross-referenced
   issue. `gh issue view <num> --comments` (run `gh issue view --help` for
   flags).
2. **Prior PRs in the same area.** `gh pr list --search 'in:title <keyword>'`
   for recent work that touched the files you're about to touch.
3. **The repo's `CLAUDE.md`.** Project-specific rules trump anything in this
   skill. If `CLAUDE.md` and this file disagree, `CLAUDE.md` wins.
4. **The surrounding code.** Glob the directory the issue points at; read
   neighboring files to learn the conventions before you imitate them.

## Output

Keep the orientation short — 3–6 bullets in your scratchpad is enough.

If the issue's `## Open questions` section has unresolved items that gate the
implementation, this is the moment to use `clobber ask` (see
`skills/ask/SKILL.md`). Don't guess load-bearing decisions.

## Done when

- You can name the file(s) you'll change and the function(s) involved.
- You know what test will demonstrate the bug or the feature.
- You've checked there isn't already an open PR doing this.

Mark the `research` item in your `TodoWrite` list as `completed` and the next
phase's item as `in_progress`. Then move to `failing-test/`.
