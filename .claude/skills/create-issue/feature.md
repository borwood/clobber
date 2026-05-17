# Feature template

Title: `feat(<scope>): <imperative summary>` · Label: `enhancement`

## Template body

```markdown
## Summary

<One or two sentences: what we'd add, who it's for. Plain words.>

## User story

<A short prose narrative — present tense, second person — that tells the story of *using* the feature once it exists. Same discipline as the vision narratives in #95: prose, not bullets; principles, not implementation. 100–250 words. Make the reader feel what the feature is like, not just what it does.>

<Example shape: *"You open clobber on a new repo. The manager has already filed three orientation issues against itself overnight — 'where do tests live,' 'is there a typecheck step,' 'what's the deploy story.' You skim its stubbed answers, correct one, and click 'accept.' Now the workspace knows the shape of the repo, and the next worker that spawns inherits it. The cost of onboarding a new codebase just dropped from 'an hour of CLAUDE.md surgery' to 'three minutes of accept/reject.'"*>

## Why

<Why now? What unblocks if we ship this? What's the cost of not having it today? Tie to a Golden Rule or roadmap pillar if applicable — re-use, modularity, flexibility, ritual.>

## Acceptance criteria

A checklist a reviewer can use to decide if the PR closing this issue is done. Behavior-shaped, not implementation-shaped. Each item independently verifiable.

- [ ] <Observable behavior 1>
- [ ] <Observable behavior 2>
- [ ] <Observable behavior 3>
- [ ] Test coverage: <integration test names or shape — per CLAUDE.md, integration tests over units>
- [ ] Docs / runbook updates: <which files, or `N/A`>

## Proposal

<Optional. A rough shape, not a design. Skip if implementation is obvious from the story. If there's a non-trivial design call, sketch the option space and which option you'd pick + one sentence why. Full discussion belongs in `## Open questions`.>

## Relevant files

<Existing files this feature touches or composes against. Cite by `path:line`. The Golden Rule is re-use — naming the existing pattern here forces the audit.>

- `packages/<pkg>/src/<file>.ts:NN` — <existing pattern to generalize>
- `packages/<pkg>/src/<file>.ts:NN` — <surface that needs to change>

## Open questions

1. <Design question — phrased so an answer would be actionable>
2. <…>

## Out of scope

- <Adjacent thing we're *not* doing here. Link a follow-up issue if one exists.>

## Severity / priority

<low | medium | high> — <one-sentence justification. Reach × strategic fit.>

## Related

- #<n> <title> — <how it connects>
```

## Checklist before filing

- [ ] User story is *prose*, not a bulleted list of capabilities. Bullets here = hiding from synthesis (same discipline as `/clobber-pm narrative`).
- [ ] ACs are *observable*, not internal. "User sees X" beats "function returns Y."
- [ ] Re-use audit done: at least one `Relevant files` entry names an existing pattern, or the issue explicitly notes *"no existing analog — net-new primitive."*
- [ ] Blue-sky reframe considered (Golden Rule 4): the framing in `## User story` is the *interesting* one, not the first one you thought of.
