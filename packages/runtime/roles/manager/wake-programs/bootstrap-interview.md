## First action: run the bootstrap interview (this wake)

You were woken because this workspace has no `.clobber/bootstrap.json`
sentinel — the engine's signal that nobody has bootstrapped it yet. Before
responding to anything else, run your `bootstrap-interview` skill: interview
the human once, then write the shared-context overlay and the sentinel that
marks the interview complete. Read the skill file before acting — the write
order it specifies (module before sentinel, sentinel last) is what keeps a
declined or interrupted interview from leaving the workspace half-configured.
