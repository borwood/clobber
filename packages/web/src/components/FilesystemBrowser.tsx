import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { BrowseDirResponse, FileReadResponse } from "@clobber/shared";
import { Portal } from "./Portal.tsx";
import { computePanelPosition } from "./panel-position.ts";

interface DirModeProps {
  readonly mode: "dir";
  readonly onSelect: (absolutePath: string) => void;
  readonly onCancel: () => void;
}

interface FileModeProps {
  readonly mode: "file";
  readonly onCancel: () => void;
}

type Props = (DirModeProps | FileModeProps) & {
  readonly initialPath?: string;
  readonly triggerRect: DOMRect;
};

const PANEL_HEIGHT_ESTIMATE = 320;

export function FilesystemBrowser(props: Props) {
  const [data, setData] = useState<BrowseDirResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileView, setFileView] = useState<FileReadResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  async function loadDir(path?: string) {
    setLoading(true);
    setError(null);
    try {
      const next = await api.browseFs(path, props.mode === "file");
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function openFile(path: string) {
    setFileLoading(true);
    setError(null);
    try {
      const result = await api.readFile(path);
      setFileView(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFileLoading(false);
    }
  }

  useEffect(() => {
    void loadDir(props.initialPath);
    // initialPath is the cold-open hint; subsequent navigation driven by clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pos = computePanelPosition(
    props.triggerRect,
    PANEL_HEIGHT_ESTIMATE,
    window.innerHeight,
    window.innerWidth,
  );
  const panelStyle: React.CSSProperties = {
    position: "fixed",
    top: pos.top,
    right: pos.right,
    zIndex: 50,
  };

  if (fileView !== null) {
    return (
      <Portal>
        <div
          style={panelStyle}
          className="w-[32rem] bg-bg border border-border-strong rounded shadow-lg p-2 flex flex-col gap-2"
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFileView(null)}
              className="px-2 py-1 rounded text-xs text-text-soft hover:text-text border border-border hover:border-border-strong"
            >
              ← back
            </button>
            <div
              className="flex-1 px-2 py-1 text-xs font-mono text-text-soft bg-surface border border-border rounded truncate"
              title={fileView.path}
            >
              {fileView.path.split("/").pop()}
            </div>
          </div>
          <pre className="max-h-80 overflow-y-auto text-xs font-mono text-text bg-surface border border-border rounded p-2 whitespace-pre-wrap break-all">
            {fileView.content}
          </pre>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={props.onCancel}
              className="px-2 py-1 rounded text-xs text-text-muted hover:text-text-dim"
            >
              close
            </button>
          </div>
        </div>
      </Portal>
    );
  }

  return (
    <Portal>
      <div
        style={panelStyle}
        className="w-96 bg-bg border border-border-strong rounded shadow-lg p-2"
      >
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={() => data?.parent !== null && data?.parent !== undefined && void loadDir(data.parent)}
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
          {fileLoading && (
            <div className="px-2 py-1 text-xs text-text-subtle">opening…</div>
          )}
          {error !== null && (
            <div className="px-2 py-1 text-xs text-danger-text font-mono break-all">{error}</div>
          )}
          {data !== null && data.entries.length === 0 && (
            <div className="px-2 py-1 text-xs text-text-subtle italic">(empty)</div>
          )}
          {data !== null &&
            data.entries.map((entry) => {
              const child = data.path === "/" ? `/${entry.name}` : `${data.path}/${entry.name}`;
              if (entry.isDir) {
                return (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() => void loadDir(child)}
                    className="w-full text-left px-2 py-1 text-xs font-mono text-text-dim hover:bg-elevated"
                  >
                    📁 {entry.name}
                  </button>
                );
              }
              if (props.mode === "file") {
                return (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() => void openFile(child)}
                    className="w-full text-left px-2 py-1 text-xs font-mono text-text-dim hover:bg-elevated"
                  >
                    📄 {entry.name}
                  </button>
                );
              }
              return null;
            })}
        </div>

        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="px-2 py-1 rounded text-xs text-text-muted hover:text-text-dim"
          >
            cancel
          </button>
          {props.mode === "dir" && (
            <button
              type="button"
              onClick={() => data !== null && props.onSelect(data.path)}
              disabled={data === null}
              className="px-2 py-1 rounded bg-accent-strong hover:bg-accent disabled:bg-elevated disabled:text-text-subtle text-xs"
            >
              select this folder
            </button>
          )}
        </div>
      </div>
    </Portal>
  );
}
