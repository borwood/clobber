# Chore template

Title: `chore(<scope>): <imperative summary>` · Label: (none)

## Template body

```markdown
## Summary

<What's the cleanup / mechanical change. One sentence.>

## Why

<What hurts about the current state. Usually: violates a Golden Rule (re-use, modularity), an Engineering Rule (file >300 lines, duplicated code, defensive nulls), or accumulates friction.>

## Proposal

<Concrete change. Mechanical chores can be specific here — "rename `Foo` to `Bar` across these files," "extract X into `packages/shared/src/Y.ts`," "delete dead code in `<file>`.">

## Relevant files

- `packages/<pkg>/src/<file>.ts:NN` — <what changes here>

## Done when

- [ ] <Observable check 1>
- [ ] <Observable check 2>
- [ ] Type check + tests green (`bun typecheck && bun test`)

## Out of scope

- <Tempting but unrelated cleanup — file separately if it matters>

## Related

- #<n> — <connection>
```

## Checklist before filing

- [ ] Chore is *mechanical*. If it requires design judgment, it's a feature in disguise — re-classify.
- [ ] `Why` cites a rule (Golden or Engineering) or a concrete friction. "Tidy-up" alone isn't enough.
- [ ] `Done when` is checkable without subjective judgment.
