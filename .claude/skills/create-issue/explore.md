# Explore / spike template

Title: `explore: <noun phrase>` · Label: (none, or `question`)

For investigations where we don't yet know the answer and want to scope the question before committing to work. Canonical example in this repo: `#65`.

## Template body

```markdown
## Idea

<One paragraph: the shape of the thing, why it might be worth doing.>

## Why this might be valuable

<What this unlocks, what category of pain it eliminates. Hedged — this is an explore, not a commit.>

## Relevant files

<If code-flavored, files to look at first. Otherwise omit.>

- `packages/<pkg>/src/<file>.ts:NN` — <relevance>

## Open questions

1. <The questions whose answers would tell us whether to act>
2. <…>

## Out of scope

- <What we're not deciding here>

## Related

- #<n> — <other explores or features this branches from>
```

## Checklist before filing

- [ ] Title is `explore: <noun phrase>` (not imperative). The shape is *"what about X?"*, not *"do X."*
- [ ] Questions in `## Open questions` are answerable in principle — not rhetorical.
- [ ] If the answer feels already-known, this is probably a `feat` in hedged clothing — re-classify.
