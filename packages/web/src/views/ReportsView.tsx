import { useState } from "react";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";
import type { FinalReportEntry } from "../api.ts";

function ReportCard({ report }: { readonly report: FinalReportEntry["report"] }) {
  if (report.free_text !== undefined) {
    return <p className="text-sm whitespace-pre-wrap">{report.free_text}</p>;
  }
  return (
    <div className="space-y-2 text-sm">
      {(["well", "badly", "useful"] as const)
        .filter((key) => report[key] !== undefined)
        .map((key) => (
          <div key={key}>
            <div className="text-text-subtle text-xs uppercase tracking-wider">{key}</div>
            <p className="whitespace-pre-wrap">{report[key]}</p>
          </div>
        ))}
    </div>
  );
}

function ReportRow({
  entry,
  expanded,
  onToggle,
}: {
  readonly entry: FinalReportEntry;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div
      data-report-id={entry.session_id}
      className="border-b border-border/30 px-3 py-2 cursor-pointer hover:bg-surface-hover"
      onClick={onToggle}
    >
      <div className="flex items-center gap-2 text-xs text-text-subtle">
        <span className="font-semibold text-text">{entry.label ?? entry.session_id.slice(0, 8)}</span>
        <span>·</span>
        <span>{entry.role}</span>
      </div>
      <div className="mt-0.5 text-sm truncate">{entry.summary}</div>
      {expanded && (
        <div
          className="mt-2 pl-2 border-l-2 border-border"
          onClick={(e) => e.stopPropagation()}
        >
          <ReportCard report={entry.report} />
        </div>
      )}
    </div>
  );
}

export function ReportsView() {
  const w = useWorkspace();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (w.invalidWorkspace) {
    return (
      <p className="text-sm text-text-subtle p-4">
        Workspace not found. Pick one above or create a new workspace.
      </p>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-sm font-semibold">
        <span>Reports</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {w.reports.length === 0 && (
          <p className="text-sm text-text-subtle px-3 py-4">No reports yet</p>
        )}
        {w.reports.map((entry) => (
          <ReportRow
            key={entry.session_id}
            entry={entry}
            expanded={expandedId === entry.session_id}
            onToggle={() =>
              setExpandedId((prev) => (prev === entry.session_id ? null : entry.session_id))
            }
          />
        ))}
      </div>
    </div>
  );
}
