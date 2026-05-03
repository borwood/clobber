import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { RoleManifestSchema, type RoleManifest } from "@clobber/shared";

export class RoleManifestError extends Error {
  override readonly name = "RoleManifestError";
}

export interface LoadedRole {
  readonly bundleRoot: string;
  readonly manifest: RoleManifest;
}

export interface DefineRoleOptions {
  readonly root: string;
  readonly manifest: unknown;
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

  const refs: readonly string[] = [
    manifest.systemPromptPath,
    manifest.settingsOverlayPath,
    ...manifest.skills.map((s) => s.path),
    ...manifest.hookScripts.map((h) => h.path),
  ];
  for (const rel of refs) {
    const abs = join(opts.root, rel);
    if (!existsSync(abs)) {
      throw new RoleManifestError(
        `referenced file missing in role bundle "${manifest.name}": ${rel}`,
      );
    }
  }

  const overlayRaw = readFileSync(
    join(opts.root, manifest.settingsOverlayPath),
    "utf8",
  );
  try {
    JSON.parse(overlayRaw);
  } catch (err) {
    throw new RoleManifestError(
      `settings overlay is not valid JSON (${manifest.settingsOverlayPath}): ${(err as Error).message}`,
    );
  }

  return Object.freeze({ bundleRoot: opts.root, manifest });
}
