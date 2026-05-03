import { mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { LoadedRole } from "./role-manifest/index.ts";

export interface MaterializeBundleOptions {
  readonly bundle: LoadedRole;
  readonly repoPath: string;
  readonly hookUrl: string;
  readonly cliEntry: string;
}

export interface MaterializedBundle {
  readonly settings: Record<string, unknown>;
  readonly binDir: string;
}

const HOOK_URL_PLACEHOLDER = "__CLOBBER_HOOK_URL__";

export function materializeBundle(opts: MaterializeBundleOptions): MaterializedBundle {
  const role = opts.bundle.manifest.name;

  const skillsDir = join(opts.repoPath, ".claude", "skills", role);
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of opts.bundle.manifest.skills) {
    const src = join(opts.bundle.bundleRoot, skill.path);
    const dest = join(skillsDir, `${skill.name}.md`);
    copyFileSync(src, dest);
  }

  const overlayRaw = readFileSync(
    join(opts.bundle.bundleRoot, opts.bundle.manifest.settingsOverlayPath),
    "utf8",
  );
  const overlaySubstituted = overlayRaw.split(HOOK_URL_PLACEHOLDER).join(opts.hookUrl);
  const settings = JSON.parse(overlaySubstituted) as Record<string, unknown>;

  const binDir = join(opts.repoPath, ".clobber", "bin");
  mkdirSync(binDir, { recursive: true });
  const shimPath = join(binDir, "clobber");
  const shim = `#!/usr/bin/env bash\nexec bun ${shellQuote(opts.cliEntry)} "$@"\n`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);

  return { settings, binDir };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
