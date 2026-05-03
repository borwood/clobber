import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PLUGIN_HOOKS_REL, type LoadedRole } from "./role-manifest/index.ts";

export interface MaterializeBundleOptions {
  readonly bundle: LoadedRole;
  readonly repoPath: string;
  readonly hookUrl: string;
  readonly cliEntry: string;
}

export interface MaterializedBundle {
  readonly pluginDir: string;
  readonly binDir: string;
}

const HOOK_URL_PLACEHOLDER = "__CLOBBER_HOOK_URL__";

export function materializeBundle(opts: MaterializeBundleOptions): MaterializedBundle {
  const role = opts.bundle.manifest.name;

  const srcPluginRoot = join(
    opts.bundle.bundleRoot,
    opts.bundle.manifest.pluginTemplatePath,
  );
  const pluginDir = join(opts.repoPath, ".clobber", "roles", role);
  copyTree(srcPluginRoot, pluginDir);

  const hooksAbs = join(pluginDir, PLUGIN_HOOKS_REL);
  if (existsSync(hooksAbs)) {
    const raw = readFileSync(hooksAbs, "utf8");
    const substituted = raw.split(HOOK_URL_PLACEHOLDER).join(opts.hookUrl);
    writeFileSync(hooksAbs, substituted);
  }

  const binDir = join(opts.repoPath, ".clobber", "bin");
  mkdirSync(binDir, { recursive: true });
  const shimPath = join(binDir, "clobber");
  const shim = `#!/usr/bin/env bash\nexec bun ${shellQuote(opts.cliEntry)} "$@"\n`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);

  return { pluginDir, binDir };
}

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d);
    } else if (entry.isFile()) {
      copyFileSync(s, d);
    } else {
      throw new Error(`unsupported file type in plugin template: ${s}`);
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
