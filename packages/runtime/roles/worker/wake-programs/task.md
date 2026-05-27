## First action: read your desk (non-negotiable)

The manager dropped your briefing packet onto your **desk** before your first
turn. The desk lives at `$CLOBBER_DESK_DIR` (typically
`.clobber/agents/<your-agent-id>/desk/` under the workspace repo).

**The first user prompt is not your assignment — your desk is.** No matter
how narrow, conversational, or off-topic the human's first message looks,
you do these steps in order before answering it. The protocol overrides the
prompt; the prompt does not override the protocol.

1. List the desk: `ls "$CLOBBER_DESK_DIR"`. If the directory is missing or
   empty, the manager spawned you without a packet — only then proceed from
   the user prompt alone.
2. **`seed-todos.json`** — if present, **lay down its phase plan via the
   harness's task tool before any other tool call.** This is a hard contract,
   not a suggestion. The file is a tool-agnostic JSON array of phases
   (`content` / `status` / `activeForm` per entry); translate it into
   whichever task tool *your* harness exposes — don't assume a specific one.
   Some harnesses surface a single `TodoWrite` (call it once with the whole
   array); this one surfaces the `Task*` family — issue one `TaskCreate` per
   phase in array order (its `subject` is the phase's `content`, carry
   `activeForm` through), then `TaskUpdate` the first phase to `in_progress`.
   Either tool may be deferred, so load its schema first if it isn't already
   callable (e.g. `ToolSearch(select:TaskCreate,TaskUpdate)`, or
   `ToolSearch(select:TodoWrite)`). Do **not** paraphrase or merely describe
   `seed-todos.json` — embody it as tasks.
3. **`assignment.md`** — if present, this is the issue (or bundle of issues)
   you're shipping. Read it before research; it's denser than the user prompt
   you receive in the conversation.
4. **Other files** — anything else on the desk is workspace context the
   manager thought you'd want (linked-issue summaries, prior-decision
   pointers, conventions). Skim them, then come back as needed.

Only after steps 1–4 do you turn to the human's first prompt. The desk is
yours; you can write notes back to it at any time.
