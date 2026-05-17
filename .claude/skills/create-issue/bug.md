# Bug template

Title: `fix(<scope>): <imperative summary>` · Label: `bug`

## Investigation pointer — session / hook / transcript bugs

If the bug involves an agent session, the hooks pipeline, or the transcript view, **read the transcript directly** before drafting. The JSONL has the exact data shape Clobber sees — which beats guessing from symptoms every time.

- Claude stores per-session transcripts at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. The `transcript_path` field on hook payloads (`packages/server/src/routes/hooks.ts`) is the authoritative pointer.
- If the user names a workspace or session, find the session id (e.g. `clobber/<workspace>/.clobber/state.db` or by listing the projects directory) and `Read` the JSONL. One entry per line — assistant messages, tool calls, tool results, and `type: "system"` lines (the latter carry `subtype`, `level`, etc.).
- Quote the relevant entry verbatim in the issue under a **Confirmed payload** section (see #118 for example). Real payloads age much better than paraphrased ones.
- Tell the user they can see these same entries inline by toggling **Show system** on the transcript — useful both for them to verify the bug and for future repros.

## Template body

```markdown
## Summary

<One or two sentences: what's broken, observed from where. No speculation about cause.>

## Steps to reproduce

1. <Concrete step — UI action, CLI invocation, API call, code path>
2. <…>
3. <…>

_If repro is not yet known:_ `_TODO: repro steps — only observed once, in <context>. Need second sighting before this is filed as a hard bug._`

## Expected vs. actual

- **Expected:** <what should happen>
- **Actual:** <what happens — include error text verbatim if any>

## Relevant files

<Cite by `path:line` — only files you've actually read. 3–8 entries. One-line note per entry on its role in the bug.>

- `packages/<pkg>/src/<file>.ts:NN` — <role>
- `packages/<pkg>/src/<file>.ts:NN` — <role>

## Environment

- Branch / commit: `<sha or branch>` (from `git rev-parse HEAD`)
- Runtime: <bun/node version, OS — only what's relevant>
- Surface: <web UI / CLI / server / hook / etc.>

## Severity / priority

<low | medium | high> — <one-sentence justification. Frequency × blast radius.>

## Related

- #<n> <title> — <how it connects>
```

## Checklist before filing

- [ ] Repro is *reproducible*. If it's "happened once," frame as `investigate intermittent <X>` — not a confirmed bug.
- [ ] No fix proposal in the body. Bugs describe the problem; fixes happen in PRs. Exception: if the user explicitly proposed a fix, capture it in a `## Proposed fix` section *after* `## Relevant files`.
- [ ] If you couldn't trace the code path, say so explicitly. *"Traced as far as `foo.ts:42`; the dispatch target was unclear."* Don't fake a trace.
- [ ] Error text is verbatim (copy-paste, not paraphrase).
