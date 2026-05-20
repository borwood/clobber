import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { RoleManifestSchema, type RoleManifest } from "@clobber/shared";
import { renderSystemPromptTemplate } from "../sdlc-profiles.ts";

export class RoleManifestError extends Error {
  override readonly name = "RoleManifestError";
}

export interface LoadedRole {
  readonly bundleRoot: string;
  readonly manifest: RoleManifest;
  readonly systemPrompt: string;
}

export interface DefineRoleOptions {
  readonly root: string;
  readonly manifest: unknown;
}

export const PLUGIN_MANIFEST_REL = ".claude-plugin/plugin.json";
export const PLUGIN_HOOKS_REL = "hooks/hooks.json";

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

  const hooksAbs = join(pluginRootAbs, PLUGIN_HOOKS_REL);
  if (existsSync(hooksAbs)) {
    const hooksRaw = readFileSync(hooksAbs, "utf8");
    try {
      JSON.parse(hooksRaw);
    } catch (err) {
      throw new RoleManifestError(
        `plugin hooks file is not valid JSON for role "${manifest.name}": ${(err as Error).message}`,
      );
    }
  }

  return Object.freeze({ bundleRoot: opts.root, manifest, systemPrompt });
}
