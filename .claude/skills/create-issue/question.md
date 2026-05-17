# Question template

Title: `question: <interrogative>` · Label: `question`

For a genuine question whose answer isn't in the codebase or docs — capture it so the answer becomes durable. Usually short.

## Template body

```markdown
## Question

<The question. One paragraph.>

## What I've already checked

- `path/to/file.ts:NN` — <what it says / doesn't say>
- `CLAUDE.md` — <section>
- <prior issues, PRs, decisions log entries>

## Why I'm asking

<The work this is blocking, or the decision it would inform.>

## Related

- #<n> — <connection>
```

## Checklist before filing

- [ ] *Already checked* is non-empty. If you haven't looked at all, look first.
- [ ] If the question is *"how should we do X,"* it's design — file as `explore:` instead, with `## Open questions`.
- [ ] If the question has an answer reachable by reading the code, read the code; don't file.
