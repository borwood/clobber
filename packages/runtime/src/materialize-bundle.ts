import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Habit, PromptModuleRef, RoleSkill, WakeProgram } from "@clobber/shared";
import { compileSelfHabits } from "./compile-self-habits.ts";
import type { HookHandler } from "./spawn-config.ts";

export interface RoleBundleData {
  readonly pluginName: string;
  readonly description?: string;
  readonly framing: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly skills: readonly RoleSkill[];
  readonly promptModuleRefs: readonly PromptModuleRef[];
  readonly wakePrograms: readonly WakeProgram[];
  // The default opening move for a fresh spawn that names none (#213). A program
  // name (or `idle`); undefined → idle.
  readonly defaultWakeProgram?: string;
  readonly hooksJson: string;
  // #271 — the role's habits. Their `self.*` members compile into hooks.json
  // (additive over the baseline) when the runtime supports in-session hooks.
  readonly habits: readonly Habit[];
}

export interface MaterializeBundleOptions {
  readonly bundle: RoleBundleData;
  readonly repoPath: string;
  readonly hookUrl: string;
  readonly cliEntry: string;
  // #271/#337 — whether the spawning runtime emits the in-session Claude hooks
  // that `self.*` habits compile to. claude: true (compile); codex: false (no-op).
  readonly inSessionHabits: boolean;
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
  writeHooks(pluginDir, bundle.hooksJson, opts.hookUrl, compiledHabitHandlers(opts));
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

type CompiledHandlers = { readonly [event: string]: readonly HookHandler[] };

// Only claude (inSessionHabits) compiles habits; codex no-ops. The result is
// empty for any role with no wired self.* habits — the byte-identical case.
function compiledHabitHandlers(opts: MaterializeBundleOptions): CompiledHandlers {
  if (!opts.inSessionHabits) return {};
  return compileSelfHabits(opts.bundle.habits, opts.hookUrl);
}

function writeHooks(
  pluginDir: string,
  hooksJson: string,
  hookUrl: string,
  compiled: CompiledHandlers,
): void {
  const hooksDir = join(pluginDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const substituted = hooksJson.split(HOOK_URL_PLACEHOLDER).join(hookUrl);
  // No compiled habit handlers ⇒ the baseline is written VERBATIM. This is the
  // continuity guard: an unmodified role's hooks.json is byte-for-byte today's.
  // Re-serialization (which reflows the hand-aligned baseline) happens only when
  // a habit actually adds a handler — i.e. for the modified role alone.
  const content =
    Object.keys(compiled).length === 0 ? substituted : mergeHandlers(substituted, compiled);
  writeFileSync(join(hooksDir, "hooks.json"), content);
}

interface HooksFile {
  readonly hooks: Record<string, HookHandler[]>;
}

function mergeHandlers(baselineJson: string, compiled: CompiledHandlers): string {
  const parsed = JSON.parse(baselineJson) as HooksFile;
  const hooks = parsed.hooks;
  for (const [event, handlers] of Object.entries(compiled)) {
    const existing = hooks[event];
    if (existing === undefined) {
      hooks[event] = [...handlers];
    } else {
      existing.push(...handlers);
    }
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function writeSkills(pluginDir: string, skills: readonly RoleSkill[]): void {
  const skillsDir = join(pluginDir, "skills");
  // Clear stale dirs so skills removed via edit don't survive re-spawn (#387).
  if (existsSync(skillsDir)) rmSync(skillsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    const skillDir = join(skillsDir, skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skill.body);
    for (const [relPath, content] of Object.entries(skill.files ?? {})) {
      writeFileSync(join(skillDir, relPath), content);
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
