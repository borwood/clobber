#!/usr/bin/env bun
import { runWithExit } from "./main.ts";

const code = await runWithExit({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
