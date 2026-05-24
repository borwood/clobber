// A clobber session sets CLOBBER_* vars ambiently, and prepareSpawnContext
// spreads process.env into the env handed to the spawned process. Left intact,
// those vars leak into the process-under-test and break spawn/attach/resume
// assertions for any agent running the suite from inside clobber. Strip them
// once at preload — before any test module imports — so the suite's result
// depends on the code, not on who runs it.
//
// Referenced by both the root bunfig.toml and packages/server/bunfig.toml so
// hermeticity holds at every scope a `bun test` runs from. One module, two
// preloads — do not copy this loop into a second file.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLOBBER_")) delete process.env[key];
}
