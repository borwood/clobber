import { useState } from "react";
import type { FileReadResponse } from "@clobber/shared";
import { Markdown } from "./Markdown.tsx";

// Non-markdown extensions we render through the Markdown pipeline as a fenced
// block, so rehype-highlight colorizes them. Markdown files render as prose.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  json: "json", py: "python", sh: "bash", bash: "bash",
  css: "css", html: "html", yml: "yaml", yaml: "yaml",
  sql: "sql", go: "go", rs: "rust", toml: "toml",
};

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function langFor(path: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  if (match === null) return null;
  const ext = match[1];
  if (ext === undefined) return null;
  const lang = EXT_LANG[ext.toLowerCase()];
  return lang === undefined ? null : lang;
}

interface Props {
  readonly file: FileReadResponse;
  readonly onBack: () => void;
  readonly onClose: () => void;
}

// Desk/office file reader: renders markdown as prose and known code/data files
// with syntax highlighting (both toggleable to raw source), and shows plain
// text wrapped on word boundaries. Reused infra: the transcript's Markdown
// renderer + its raw-behind-toggle pattern.
export function FileViewer({ file, onBack, onClose }: Props) {
  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const lang = isMarkdown ? null : langFor(file.path);
  const canRender = isMarkdown || lang !== null;
  const [raw, setRaw] = useState(false);
  const showRendered = canRender && !raw;
  const fenced = `\`\`\`${lang}\n${file.content}\n\`\`\``;

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="px-2 py-1 rounded text-xs text-text-soft hover:text-text border border-border hover:border-border-strong"
        >
          ← back
        </button>
        <div
          className="flex-1 px-2 py-1 text-xs font-mono text-text-soft bg-surface border border-border rounded truncate"
          title={file.path}
        >
          {basename(file.path)}
        </div>
        {canRender && (
          <button
            type="button"
            onClick={() => setRaw((v) => !v)}
            title={raw ? "Show rendered" : "Show raw source"}
            className="px-2 py-1 rounded text-xs text-text-muted hover:text-text-dim border border-border hover:border-border-strong"
          >
            {raw ? "rendered" : "raw"}
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto bg-surface border border-border rounded p-3">
        {showRendered ? (
          <Markdown text={isMarkdown ? file.content : fenced} />
        ) : (
          <pre className="text-xs font-mono text-text whitespace-pre-wrap break-words">
            {file.content}
          </pre>
        )}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1 rounded text-xs text-text-muted hover:text-text-dim"
        >
          close
        </button>
      </div>
    </div>
  );
}
