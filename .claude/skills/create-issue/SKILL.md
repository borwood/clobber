---
name: create-issue
description: File a GitHub issue against this repo — bug, feature, chore, docs, explore, or question. For code-related issues, explore the relevant code first and cite sources by `file:line`. For feature requests, draft a user-story narrative + acceptance criteria. Never guess; ask the user for follow-up detail when needed. Invoked when the user types `/create-issue [free text]` or asks to file/open/raise an issue.
---

# /create-issue — file a GitHub issue against brennan-volter/clobber

Turn a fuzzy human ask into an issue another agent can pick up cold. One procedure, six issue shapes — each shape's template lives in its own companion file.

## Guardrails (apply to every shape)

1. **Never guess.** Unknown fact → `_TODO: <what's missing>_` placeholder + surface to user before filing. Don't invent.
2. **Cite sources.** Code claims use `path/to/file.ts:NN`. History/decisions cite `#NN`, PR, or commit SHA.
3. **Confirm before filing.** Show the draft, ask "file / edit / discard?" Only then `gh issue create`.
4. **Re-use first** (Golden Rule). Run `gh issue list --search "<keywords>"` before drafting; if a near-duplicate exists, surface it and stop.
5. **Don't pollute `#70` or `#95`.** Those are managed by `/clobber-pm`. New issues stand alone.

## Procedure

1. **Classify.** Pick a shape from the dispatch table below. If genuinely ambiguous, ask the user.
2. **Explore (if code-related).** Read the relevant files. >2 lookups or open-ended *"where does X happen"* → spawn an `Explore` subagent. Known symbol → `grep -rn`. Known path → `Read`. Capture 3–8 relevant files; for bugs, trace the actual code path; for features, find the existing pattern to compose against.
3. **Draft.** Read the companion template file and fill it. Unknowns become `_TODO:` placeholders. Omit empty sections rather than padding with `N/A`.
4. **Confirm.** Print title + body in a code block. Walk through any `_TODO:` placeholders with the user. Re-draft if substantive feedback.
5. **File.** Write body to `/tmp/clobber-issue-draft.md`, then `gh issue create --repo brennan-volter/clobber --title "<title>" --body-file /tmp/clobber-issue-draft.md --label "<labels>"`. Return the URL.

## Dispatch — shape → companion file

| Shape | Title prefix | Label | Template |
|---|---|---|---|
| Bug | `fix(<scope>):` | `bug` | [bug.md](bug.md) |
| Feature | `feat(<scope>):` | `enhancement` | [feature.md](feature.md) |
| Chore | `chore(<scope>):` | (none) | [chore.md](chore.md) |
| Docs | `doc(<scope>):` | `documentation` | [docs.md](docs.md) |
| Explore / spike | `explore:` | (none, or `question`) | [explore.md](explore.md) |
| Question | `question:` | `question` | [question.md](question.md) |

`<scope>` matches monorepo packages (`server`, `web`, `runtime`, `cli`, `shared`) or cross-cutting tags (`safety`, `pm`, `docs`, `dx`, `ux`) — mirror recent commits/issues, don't invent.

## Title conventions

- Conventional Commits prefix matching the shape.
- Lowercase after the prefix. No trailing period. Under ~70 chars.
- Imperative mood for actionable shapes (`feat`, `fix`, `chore`, `doc`). Noun-phrase or interrogative for `explore` and `question`.
- Examples mined from this repo: `feat(safety): PreToolUse hook to refuse writes outside the caller's own office` · `explore: control session UUIDs from clobber via --session-id / --name`.

## What NOT to do

- **Wrong repo.** Default is `brennan-volter/clobber`. Claude Code / SDK bugs → direct the user to `https://github.com/anthropics/claude-code/issues`, don't file here.
- **Assignees / milestones / projects** unless the user explicitly asks. `/clobber-pm` manages those.
- **`pm:*` labels** — also `/clobber-pm`'s surface.
- **Pad empty sections with `N/A`** — drop the section instead. Exception: when the absence is itself informative (e.g. *"no related issues — net-new area"*).

## Quick references

| Resource | Location |
|---|---|
| Repo issues | https://github.com/brennan-volter/clobber/issues |
| Canonical issue examples | #61, #65 |
| Labels available | `bug`, `enhancement`, `documentation`, `question` (avoid `pm:*`) |
| Roadmap / vision (read-only here) | #70 / #95 |
| Golden + Engineering Rules | `<repo-root>/CLAUDE.md` |

## Sunset

Redundant once clobber's manager agent files its own issues end-to-end from worker reports — the templates move into the manager's runbook and `/create-issue` collapses to a wrapper or disappears.
