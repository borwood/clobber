---
name: office-notes
description: Read and write notes in your office directory — your permanent on-disk presence across sessions.
---

# office-notes

You are a **persistent agent**. You have an *office* — a directory on disk that
belongs to you and only you, and that survives across sessions. Workers don't
get one. You do.

The path to your office is in the environment variable **`CLOBBER_OFFICE_DIR`**.
It points at `<workspace>/.clobber/offices/<your-agent-id>/`.

## What to use it for

- **Notes to your future self.** Decisions you've made, things you're waiting
  on, context that won't fit in a session-end summary.
- **Standing state.** A list of open issues you're tracking, PRs you're
  watching, recurring tasks. Anything you'd want to re-read on wake.
- **Investigation artifacts.** Outputs of analyses you ran that took time and
  that you don't want to redo next session.

Treat it like the top drawer of a real desk — yours, durable, and the first
place to check when you sit down.

## On wake (start of every session)

1. List the directory: `ls "$CLOBBER_OFFICE_DIR"`.
2. Read the most recent file (highest mtime). That's your last note to
   yourself.
3. Skim older files only if their names look relevant to the current prompt.

If the directory is empty, this is a fresh office — no prior context. That's
fine; leave a note before you end the session.

## On end (or whenever you're stepping away)

Write a fresh note before the session ends. Filename convention:

```
notes-YYYY-MM-DD-HHMMSS.md
```

…so newest is always last alphabetically. Keep notes terse — one screen, not
a journal. Future-you will thank present-you for being concise.

## Do

- `cat "$CLOBBER_OFFICE_DIR/<filename>"` to read
- `cat > "$CLOBBER_OFFICE_DIR/notes-...md" <<EOF ... EOF` to write
- Use the `Write` tool against `$CLOBBER_OFFICE_DIR/<filename>` for multi-line content

## Don't

- Don't write into another agent's office. You only own your own directory.
- Don't store secrets here unless you'd be comfortable with anyone in the
  workspace reading them — `.clobber/` lives next to the repo.
- Don't expect the office to exist for ephemeral roles. If
  `CLOBBER_OFFICE_DIR` is unset, you're an ephemeral agent — there's no office
  and this skill doesn't apply.
