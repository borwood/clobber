import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  HabitSchema,
  RoleManifestSchema,
  type Habit,
  type PermissionMode,
  type RoleManifest,
  type RoleSkill,
} from "@clobber/shared";
import { renderSystemPromptTemplate } from "../sdlc-profiles.ts";

export class RoleManifestError extends Error {
  override readonly name = "RoleManifestError";
}

// The universal layer every agent forks from (#355). `base` is abstract — it is
// never embodied (never seeded, never spawned), it only contributes its content
// to a fork's effective role. A fork that does not re-specify base content
// inherits it, so a future base update merges in cleanly instead of duplicating.
export interface BaseLayer {
  readonly bundleRoot: string;
  readonly allowedTools: readonly string[];
  readonly permissionMode: PermissionMode | undefined;
  readonly hooksJson: string;
  readonly skills: readonly RoleSkill[];
}

// A fully-resolved role: the fork's own identity (framing, system prompt,
// manifest) plus the effective content after composing the base layer in.
// `allowedTools`, `permissionMode`, `hooksJson`, `skills`, and `habits` are
// the composed values — downstream snapshotting projects these directly,
// never re-reading the bundle from disk.
export interface LoadedRole {
  readonly bundleRoot: string;
  readonly manifest: RoleManifest;
  readonly framing: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly permissionMode: PermissionMode | undefined;
  readonly hooksJson: string;
  readonly skills: readonly RoleSkill[];
  // Habits loaded from <root>/habits/<category>/<event>/<name>.json.
  // Empty when the role ships no habits.
  readonly habits: readonly Habit[];
}

export interface DefineRoleOptions {
  readonly root: string;
  readonly manifest: unknown;
  // The base layer this role forks from. Omitted only by base-less roles (e.g.
  // ad-hoc test bundles); shipped roles all fork from `base`.
  readonly base?: BaseLayer;
}

export interface DefineBaseRoleOptions {
  readonly root: string;
  readonly pluginTemplatePath: string;
  readonly allowedTools: readonly string[];
  readonly permissionMode?: PermissionMode;
}

export const PLUGIN_MANIFEST_REL = ".claude-plugin/plugin.json";
export const PLUGIN_HOOKS_REL = "hooks/hooks.json";
export const PLUGIN_SKILLS_REL = "skills";

// Build the abstract base layer from its bundle. Base carries no identity
// (no framing / system prompt) — only the universal content that forks inherit.
export function defineBaseRole(opts: DefineBaseRoleOptions): BaseLayer {
  if (!isAbsolute(opts.root)) {
    throw new RoleManifestError(`base role root must be absolute, got: ${opts.root}`);
  }
  const pluginRoot = join(opts.root, opts.pluginTemplatePath);
  if (!existsSync(pluginRoot) || !statSync(pluginRoot).isDirectory()) {
    throw new RoleManifestError(`base plugin template missing or not a directory: ${pluginRoot}`);
  }
  const hooksJson = loadHooks(pluginRoot, "base");
  const skills = readSkills(join(pluginRoot, PLUGIN_SKILLS_REL));
  return Object.freeze({
    bundleRoot: opts.root,
    allowedTools: opts.allowedTools,
    permissionMode: opts.permissionMode,
    hooksJson,
    skills,
  });
}

export function defineRole(opts: DefineRoleOptions): LoadedRole {
  if (!isAbsolute(opts.root)) {
    throw new RoleManifestError(`role root must be absolute, got: ${opts.root}`);
  }

  const parsed = RoleManifestSchema.safeParse(opts.manifest);
  if (!parsed.success) {
    throw new RoleManifestError(
      `manifest failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }
  const manifest = parsed.data;

  const systemPromptAbs = join(opts.root, manifest.systemPromptPath);
  if (!existsSync(systemPromptAbs)) {
    throw new RoleManifestError(
      `system prompt missing in role bundle "${manifest.name}": ${manifest.systemPromptPath}`,
    );
  }
  const rawSystemPrompt = readFileSync(systemPromptAbs, "utf8");
  if (rawSystemPrompt.trim().length === 0) {
    throw new RoleManifestError(
      `system prompt is empty for role "${manifest.name}": ${manifest.systemPromptPath}`,
    );
  }
  let systemPrompt: string;
  try {
    systemPrompt = renderSystemPromptTemplate(rawSystemPrompt, manifest.sdlc);
  } catch (err) {
    throw new RoleManifestError(
      `system prompt render failed for role "${manifest.name}": ${(err as Error).message}`,
    );
  }

  const framing = loadFraming(opts.root, manifest);

  const pluginRootAbs = join(opts.root, manifest.pluginTemplatePath);
  if (!existsSync(pluginRootAbs) || !statSync(pluginRootAbs).isDirectory()) {
    throw new RoleManifestError(
      `plugin template missing or not a directory for role "${manifest.name}": ${manifest.pluginTemplatePath}`,
    );
  }

  const pluginJsonAbs = join(pluginRootAbs, PLUGIN_MANIFEST_REL);
  if (!existsSync(pluginJsonAbs)) {
    throw new RoleManifestError(
      `plugin manifest missing for role "${manifest.name}": ${manifest.pluginTemplatePath}/${PLUGIN_MANIFEST_REL}`,
    );
  }
  const pluginJsonRaw = readFileSync(pluginJsonAbs, "utf8");
  let pluginJson: { name?: unknown };
  try {
    pluginJson = JSON.parse(pluginJsonRaw) as { name?: unknown };
  } catch (err) {
    throw new RoleManifestError(
      `plugin manifest is not valid JSON for role "${manifest.name}": ${(err as Error).message}`,
    );
  }
  if (pluginJson.name !== manifest.name) {
    throw new RoleManifestError(
      `plugin manifest name (${JSON.stringify(pluginJson.name)}) does not match role name (${JSON.stringify(manifest.name)})`,
    );
  }

  const { base } = opts;
  const hooksJson = resolveHooks(pluginRootAbs, manifest.name, base);
  const allowedTools = resolveAllowedTools(manifest, base);
  const permissionMode = manifest.permissionMode ?? base?.permissionMode;
  const skills = composeSkills(base?.skills ?? [], readSkills(join(pluginRootAbs, PLUGIN_SKILLS_REL)));
  const habits = readHabits(join(opts.root, "habits"));

  return Object.freeze({
    bundleRoot: opts.root,
    manifest,
    framing,
    systemPrompt,
    allowedTools,
    permissionMode,
    hooksJson,
    skills,
    habits,
  });
}

// A fork inherits base's hooks unless it ships its own. base owns the universal
// observability mechanism, so forks carry no hooks file of their own.
function resolveHooks(
  pluginRootAbs: string,
  roleName: string,
  base: BaseLayer | undefined,
): string {
  const hooksAbs = join(pluginRootAbs, PLUGIN_HOOKS_REL);
  if (existsSync(hooksAbs)) return loadHooks(pluginRootAbs, roleName);
  // A fork ships no hooks of its own — it inherits base's. A base-less role
  // with no hooks simply has none (the pre-#355 tolerant behaviour).
  if (base !== undefined) return base.hooksJson;
  return "";
}

function resolveAllowedTools(
  manifest: RoleManifest,
  base: BaseLayer | undefined,
): readonly string[] {
  if (manifest.allowedTools !== undefined) return manifest.allowedTools;
  if (base !== undefined) return base.allowedTools;
  return [];
}

// Merge base skills with the fork's, keyed by name; the fork's body wins on a
// name collision. Sorted by name so the projection is order-stable.
function composeSkills(
  baseSkills: readonly RoleSkill[],
  forkSkills: readonly RoleSkill[],
): readonly RoleSkill[] {
  const byName = new Map<string, RoleSkill>();
  for (const skill of baseSkills) byName.set(skill.name, skill);
  for (const skill of forkSkills) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function loadHooks(pluginRootAbs: string, roleName: string): string {
  const hooksAbs = join(pluginRootAbs, PLUGIN_HOOKS_REL);
  const raw = readFileSync(hooksAbs, "utf8");
  try {
    JSON.parse(raw);
  } catch (err) {
    throw new RoleManifestError(
      `plugin hooks file is not valid JSON for role "${roleName}": ${(err as Error).message}`,
    );
  }
  return raw;
}

function readSkills(skillsDir: string): readonly RoleSkill[] {
  const out: RoleSkill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    out.push({ name: entry.name, body: readFileSync(skillFile, "utf8") });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// Recursively scans <habitsDir>/<category>/<event>/<name>.json. Returns an
// empty array when the directory doesn't exist (roles with no habits).
function readHabits(habitsDir: string): readonly Habit[] {
  if (!existsSync(habitsDir) || !statSync(habitsDir).isDirectory()) return [];
  const habits: Habit[] = [];
  for (const categoryEntry of readdirSync(habitsDir, { withFileTypes: true })) {
    if (!categoryEntry.isDirectory()) continue;
    const categoryDir = join(habitsDir, categoryEntry.name);
    for (const eventEntry of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!eventEntry.isDirectory()) continue;
      const eventDir = join(categoryDir, eventEntry.name);
      for (const fileEntry of readdirSync(eventDir, { withFileTypes: true })) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) continue;
        const raw = readFileSync(join(eventDir, fileEntry.name), "utf8");
        habits.push(HabitSchema.parse(JSON.parse(raw)));
      }
    }
  }
  habits.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return habits;
}

function loadFraming(root: string, manifest: RoleManifest): string {
  if (manifest.framingPath === undefined) return "";
  const framingAbs = join(root, manifest.framingPath);
  if (!existsSync(framingAbs)) {
    throw new RoleManifestError(
      `framing file missing in role bundle "${manifest.name}": ${manifest.framingPath}`,
    );
  }
  const raw = readFileSync(framingAbs, "utf8");
  if (raw.trim().length === 0) {
    throw new RoleManifestError(
      `framing file is empty for role "${manifest.name}": ${manifest.framingPath}`,
    );
  }
  return raw;
}
