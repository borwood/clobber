# Docs template

Title: `doc(<scope>): <imperative summary>` · Label: `documentation`

## Template body

```markdown
## Summary

<What's missing, wrong, or unclear. Be specific — "the architecture doc doesn't say how roles inherit" beats "docs are confusing.">

## Where

- `path/to/doc.md` — <section or line range>
- `CLAUDE.md` — <section if relevant>

## What should it say (sketch)

<A paragraph or bullets the doc writer can start from. Doesn't have to be polished prose.>

## Why it matters

<Who hits the gap, when, and what they do wrong because of it. Cite a concrete incident if there was one.>

## Related

- #<n> — <connection>
```

## Checklist before filing

- [ ] *Specific* gap, not a vibe. If you can't point at a passage or an absence, the issue isn't ready.
- [ ] If the fix is one-line, just open a PR instead of an issue. Issues are for docs work that needs scoping or discussion.
- [ ] No top-level new doc files unless the user explicitly asks — `CLAUDE.md` and `README.md` are the load-bearing surfaces (per CLAUDE.md guardrails).
