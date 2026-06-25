import { useEffect, useMemo, useState } from "react";
import { RoleEditRequestSchema } from "@clobber/shared";
import { api, type RoleDetailResponse } from "../api.ts";
import { describeSchema, type NamedField } from "../lib/schema-introspect.ts";
import { SchemaField, type OverrideRegistry } from "./settings/SchemaField.tsx";
import { RolePromptField } from "./settings/RolePromptField.tsx";
import { ActionButton } from "./ActionButton.tsx";

interface Props {
  readonly workspaceId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly onClose: () => void;
  // The picker reloads its role list (commit badge / description) after a save.
  readonly onSaved: () => void;
}

// system_prompt gets a markdown editor with preview; everything else renders
// structurally from RoleEditRequestSchema. Array-of-object fields (triggers,
// skills, wake programs, prompt modules) fall through to the schema's honest
// raw-JSON editor (GR7 — nothing silently disappears) and live behind the
// Advanced disclosure so the common edit (description / prompt / tools) stays clean.
const OVERRIDES: OverrideRegistry = { system_prompt: RolePromptField };
const PRIMARY_KEYS = new Set(["description", "system_prompt", "allowed_tools"]);

// Pull the editable fields off the loaded role detail. `description` is top-level
// on the response; the rest live under current_version. Absent values seed empty
// so the schema-driven controls have something to bind to.
function seedDraft(detail: RoleDetailResponse, keys: readonly string[]): Record<string, unknown> {
  const v = detail.current_version as unknown as Record<string, unknown>;
  const seed: Record<string, unknown> = {};
  for (const k of keys) {
    seed[k] = k === "description" ? detail.description : v[k];
  }
  return seed;
}

export function RoleEditorModal({ workspaceId, roleId, roleName, onClose, onSaved }: Props) {
  const root = useMemo(() => describeSchema(RoleEditRequestSchema), []);
  const fields: readonly NamedField[] = root.kind === "object" ? root.fields : [];
  const keys = useMemo(() => fields.map((f) => f.key), [fields]);

  const [initial, setInitial] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getWorkspaceRoleDetail(workspaceId, roleId)
      .then((detail) => {
        if (!live) return;
        const seed = seedDraft(detail, keys);
        setInitial(seed);
        setDraft(seed);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [workspaceId, roleId, keys]);

  async function save() {
    if (initial === null) return;
    const patch: Record<string, unknown> = {};
    for (const k of keys) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(initial[k])) patch[k] = draft[k];
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const parsed = RoleEditRequestSchema.safeParse(patch);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.editWorkspaceRole(workspaceId, roleId, parsed.data);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const primary = fields.filter((f) => PRIMARY_KEYS.has(f.key));
  const advanced = fields.filter((f) => !PRIMARY_KEYS.has(f.key));

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="flex flex-col w-[46rem] max-w-[92vw] max-h-[90vh] bg-bg border border-border-strong rounded-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border shrink-0">
          <div className="text-sm font-semibold text-text">edit role</div>
          <div className="text-xs text-text-subtle font-mono truncate">{roleName}</div>
        </div>

        <div className="px-4 py-3 overflow-y-auto min-h-0 flex-1">
          {initial === null && error === null && (
            <div className="text-xs text-text-subtle">loading role…</div>
          )}
          {initial !== null && (
            <div className="flex flex-col gap-4">
              <FieldList
                fields={primary}
                draft={draft}
                onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
              />
              {advanced.length > 0 && (
                <div className="border-t border-border pt-3">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((s) => !s)}
                    className="text-xs text-text-muted hover:text-text-dim"
                  >
                    {showAdvanced ? "▾" : "▸"} advanced (triggers, skills, wake programs, prompt modules)
                  </button>
                  {showAdvanced && (
                    <div className="mt-3">
                      <FieldList
                        fields={advanced}
                        draft={draft}
                        onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {error !== null && (
          <div className="px-4 py-2 text-xs text-danger-text font-mono break-all shrink-0">{error}</div>
        )}

        <div className="px-4 py-3 border-t border-border flex justify-end gap-2 shrink-0 bg-bg">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1 rounded text-xs text-text-muted hover:text-text-dim"
          >
            cancel
          </button>
          <ActionButton
            variant="accent"
            onClick={() => void save()}
            disabled={busy || initial === null}
            className="px-3 py-1 text-xs"
          >
            {busy ? "saving…" : "save"}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function FieldList({
  fields,
  draft,
  onChange,
}: {
  fields: readonly NamedField[];
  draft: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {fields.map((f) => (
        <div key={f.key} className="space-y-1">
          <div className="text-xs text-text-dim">{f.meta.title ?? f.key}</div>
          {f.meta.description !== undefined && (
            <div className="text-xs text-text-subtle">{f.meta.description}</div>
          )}
          <div className="pt-0.5">
            <SchemaField
              node={f.node}
              value={draft[f.key]}
              onChange={(v) => onChange(f.key, v)}
              overrides={OVERRIDES}
              path={f.key}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
