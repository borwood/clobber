import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";

// "Where" the agent is: its latest working directory (from the most recent hook
// event's cwd). Paths are long, so the leading segments truncate and the tail —
// the worktree/branch folder that actually identifies the location — stays
// visible. Full path on hover.
export function CwdLine({ cwd }: { readonly cwd: string }) {
  return (
    <div
      className="mt-1 flex items-center gap-1 text-[11px] text-text-subtle font-mono min-w-0"
      title={cwd}
    >
      <FolderOpenIcon className="shrink-0 size-3 text-text-faint" weight="regular" />
      {/* Left-truncate: rtl direction puts the ellipsis on the left while
          unicode-bidi:plaintext keeps the path segments in their natural order,
          so the trailing worktree/branch folder stays visible. */}
      <span
        className="truncate"
        style={{ direction: "rtl", unicodeBidi: "plaintext", textAlign: "left" }}
      >
        {cwd}
      </span>
    </div>
  );
}
