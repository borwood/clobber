import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleSkill } from "@clobber/shared";

export interface RoleBundleData {
  readonly pluginName: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly skills: readonly RoleSkill[];
  readonly hooksJson: string;
}

export interface MaterializeBundleOptions {
  readonly bundle: RoleBundleData;
  readonly repoPath: string;
  readonly hookUrl: string;
  readonly cliEntry: string;
}

export interface MaterializedBundle {
  readonly pluginDir: string;
  readonly binDir: string;
}

const HOOK_URL_PLACEHOLDER = "__CLOBBER_HOOK_URL__";
const PLUGIN_VERSION = "0.0.1";

export function materializeBundle(opts: MaterializeBundleOptions): MaterializedBundle {
  const { bundle } = opts;
  const pluginDir = join(opts.repoPath, ".clobber", "roles", bundle.pluginName);

  writePluginManifest(pluginDir, bundle);
  writeHooks(pluginDir, bundle.hooksJson, opts.hookUrl);
  writeSkills(pluginDir, bundle.skills);

  const binDir = join(opts.repoPath, ".clobber", "bin");
  mkdirSync(binDir, { recursive: true });
  const shimPath = join(binDir, "clobber");
  const shim = `#!/usr/bin/env bash\nexec bun ${shellQuote(opts.cliEntry)} "$@"\n`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);

  return { pluginDir, binDir };
}

function writePluginManifest(pluginDir: string, bundle: RoleBundleData): void {
  const manifestDir = join(pluginDir, ".claude-plugin");
  mkdirSync(manifestDir, { recursive: true });
  const manifest: Record<string, string> = {
    name: bundle.pluginName,
    version: PLUGIN_VERSION,
  };
  if (bundle.description !== undefined) manifest["description"] = bundle.description;
  writeFileSync(
    join(manifestDir, "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function writeHooks(pluginDir: string, hooksJson: string, hookUrl: string): void {
  const hooksDir = join(pluginDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const substituted = hooksJson.split(HOOK_URL_PLACEHOLDER).join(hookUrl);
  writeFileSync(join(hooksDir, "hooks.json"), substituted);
}

function writeSkills(pluginDir: string, skills: readonly RoleSkill[]): void {
  const skillsDir = join(pluginDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    const skillDir = join(skillsDir, skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skill.body);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
