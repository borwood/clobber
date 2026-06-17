import { useMemo, useState } from "react";
import { UpdateWorkspaceConfigRequestSchema } from "@clobber/shared";
import { api, type Workspace } from "../api.ts";
import { describeSchema } from "../lib/schema-introspect.ts";
import { previewWorkspaceTheme } from "../lib/apply-theme.ts";
import { SchemaField, type OverrideRegistry } from "./settings/SchemaField.tsx";
import { ThemeField } from "./settings/ThemeField.tsx";
import { ActionButton } from "./ActionButton.tsx";

interface Props {
  readonly workspace: Workspace;
  readonly onClose: () => void;
  readonly onSaved: (updated: Workspace) => void;
}

// Differentiated fields re-introduced as override branches; everything else
// renders structurally from the schema.
const OVERRIDES: OverrideRegistry = { theme: ThemeField };

// The settings surface projects entirely from the canonical workspace schema:
// every patchable field renders by rule, so a new field appears here the moment
// it lands in the schema — no edit to this modal.
export function WorkspaceConfigModal({ workspace, onClose, onSaved }: Props) {
  const root = useMemo(() => describeSchema(UpdateWorkspaceConfigRequestSchema), []);
  const keys = root.kind === "object" ? root.fields.map((f) => f.key) : [];

  const initial = useMemo(() => {
    const seed: Record<string, unknown> = {};
    for (const k of keys) seed[k] = (workspace as unknown as Record<string, unknown>)[k];
    return seed;
  }, [workspace, keys]);

  const [draft, setDraft] = useState<Record<string, unknown>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cancel(): void {
    previewWorkspaceTheme(workspace.theme);
    onClose();
  }

  async function save() {
    const patch: Record<string, unknown> = {};
    for (const k of keys) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(initial[k])) patch[k] = draft[k];
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const parsed = UpdateWorkspaceConfigRequestSchema.safeParse(patch);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateWorkspaceConfig(workspace.id, parsed.data);
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={cancel}>
      <div
        className="w-[32rem] max-w-[90vw] max-h-[90vh] overflow-y-auto bg-bg border border-border-strong rounded-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold text-text">workspace settings</div>
          <div className="text-xs text-text-subtle font-mono truncate">
            {workspace.name} · {workspace.repo_path}
          </div>
        </div>

        <div className="px-4 py-3">
          <SchemaField
            node={root}
            value={draft}
            onChange={(v) => setDraft(v as Record<string, unknown>)}
            overrides={OVERRIDES}
            path=""
          />
        </div>

        {error !== null && (
          <div className="px-4 py-2 text-xs text-danger-text font-mono break-all">{error}</div>
        )}

        <div className="px-4 py-3 border-t border-border flex justify-end gap-2 sticky bottom-0 bg-bg">
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="px-3 py-1 rounded text-xs text-text-muted hover:text-text-dim"
          >
            cancel
          </button>
          <ActionButton
            variant="accent"
            onClick={() => void save()}
            disabled={busy}
            className="px-3 py-1 text-xs"
          >
            {busy ? "saving…" : "save"}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
