import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { BrowseDirResponse } from "@clobber/shared";

interface Props {
  readonly onSelect: (absolutePath: string) => void;
  readonly onCancel: () => void;
  readonly initialPath?: string;
}

export function FolderPicker({ onSelect, onCancel, initialPath }: Props) {
  const [data, setData] = useState<BrowseDirResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(path?: string) {
    setLoading(true);
    setError(null);
    try {
      const next = await api.browseFs(path);
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(initialPath);
    // initialPath is the cold-open hint; subsequent navigation is driven
    // by user clicks, not by changes to initialPath, so this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute z-10 top-full left-0 mt-1 w-96 bg-bg border border-border-strong rounded shadow-lg p-2">
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => data?.parent !== null && data?.parent !== undefined && void load(data.parent)}
          disabled={data === null || data.parent === null || loading}
          className="px-2 py-1 rounded text-xs text-text-soft hover:text-text disabled:text-text-faint border border-border hover:border-border-strong disabled:border-surface"
          title="Up one level"
        >
          ↑
        </button>
        <div
          className="flex-1 px-2 py-1 text-xs font-mono text-text-soft bg-surface border border-border rounded truncate"
          title={data?.path ?? ""}
        >
          {data?.path ?? (loading ? "loading…" : "")}
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto border border-border rounded bg-surface">
        {loading && data === null && (
          <div className="px-2 py-1 text-xs text-text-subtle">loading…</div>
        )}
        {error !== null && (
          <div className="px-2 py-1 text-xs text-danger-text font-mono break-all">{error}</div>
        )}
        {data !== null && data.entries.length === 0 && (
          <div className="px-2 py-1 text-xs text-text-subtle italic">(no subdirectories)</div>
        )}
        {data !== null &&
          data.entries.map((entry) => {
            const child = data.path === "/" ? `/${entry.name}` : `${data.path}/${entry.name}`;
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => void load(child)}
                className="w-full text-left px-2 py-1 text-xs font-mono text-text-dim hover:bg-elevated"
              >
                📁 {entry.name}
              </button>
            );
          })}
      </div>

      <div className="flex justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 rounded text-xs text-text-muted hover:text-text-dim"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={() => data !== null && onSelect(data.path)}
          disabled={data === null}
          className="px-2 py-1 rounded bg-accent-strong hover:bg-accent disabled:bg-elevated disabled:text-text-subtle text-xs"
        >
          select this folder
        </button>
      </div>
    </div>
  );
}
